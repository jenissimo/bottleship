import { describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { registerShaderCommands } from "../../src/worker/harness/cmds/shader";
import { Emitter } from "../../src/worker/backends/webgpu/d3d9/shader/emitter";
import { structureProgram, StructureError } from "../../src/worker/backends/webgpu/d3d9/shader/passes/structure";
import { planUniformity } from "../../src/worker/backends/webgpu/d3d9/shader/passes/uniformity";
import { emitSampleDerivatives, emitTextureSample } from "../../src/worker/backends/webgpu/d3d9/shader/emit/tex";
import { Census } from "../../src/worker/backends/webgpu/d3d9/shader/census";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

function source(type: RegType, num: number): SmSource {
    return {
        reg: { type, num, relative: false },
        swizzle: 0xe4,
        modifier: 0,
    };
}

function instruction(opcode: Op, src: SmSource[] = [], specificData = 0, dst: SmInstruction["dst"] = null): SmInstruction {
    return {
        opcode,
        coissue: false,
        predicated: false,
        specificData,
        dst,
        src,
    };
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

function program(instructions: SmInstruction[]): SmProgram {
    return { instructions } as SmProgram;
}

type Handler = (args: unknown[], ctx: unknown) => unknown | Promise<unknown>;

class StubHarnessService {
    readonly handlers = new Map<string, Handler>();

    register(name: string, handler: Handler): void {
        this.handlers.set(name, handler);
    }
}

describe("d3d9 SM3 scaffolding", () => {
    test("represents an empty flat program as one instruction block", () => {
        expect(structureProgram(program([]))).toEqual([{ kind: "instrs", instrs: [] }]);
    });

    test("structures an if/else and keeps ordinary instructions in instrs blocks", () => {
        const mov = instruction(Op.NOP);
        const blocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.CONSTBOOL, 0)]),
            mov,
            instruction(Op.ELSE),
            instruction(Op.NOP),
            instruction(Op.ENDIF),
        ]));

        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({ kind: "if", else_: [{ kind: "instrs" }] });
        expect(blocks[0]).toMatchObject({ then: [{ kind: "instrs", instrs: [mov] }] });
    });

    test("throws a structured error for an if without endif", () => {
        try {
            structureProgram(program([instruction(Op.IF, [source(RegType.CONSTBOOL, 0)])]));
            throw new Error("expected structureProgram to reject an unclosed if");
        } catch (error) {
            expect(error).toBeInstanceOf(StructureError);
            expect(error).toMatchObject({ code: "unclosed-block", opcode: Op.IF });
        }
    });

    test("emitter balances braces and keeps indentation and temporary names", () => {
        const emitter = new Emitter();
        emitter.open("if (true)");
        const first = emitter.tmp("value");
        emitter.line(`${first} = 1;`);
        emitter.close("else");
        emitter.line(`${emitter.tmp("value")} = 2;`);
        emitter.close();

        expect(emitter.depth()).toBe(0);
        expect(emitter.toString()).toBe([
            "if (true) {",
            `    ${first} = 1;`,
            "} else {",
            "    _value1 = 2;",
            "}",
        ].join("\n"));
    });

    test("census makes every unsupported opcode link-fatal", () => {
        const census = new Census();
        census.record(Op.IF, "unsupported");
        census.record(Op.MOV, "unsupported");

        expect(census.linkError()).not.toBeNull();
        expect(() => census.assertLinkable()).toThrow(/cannot be linked/);
        // The refusal IS the report — there is no in-WGSL marker to fall back on.
        expect(census.summary()).toMatchObject({
            unsupported: 2,
            total: 2,
            unsupportedOps: ["if", "mov"],
        });
    });

    test("rejects flow nesting beyond the D3D9 dynamic-depth limit", () => {
        const instructions = [
            ...Array.from({ length: 25 }, () => instruction(Op.IF, [source(RegType.CONSTBOOL, 0)])),
            ...Array.from({ length: 25 }, () => instruction(Op.ENDIF)),
        ];
        expect(() => structureProgram(program(instructions))).toThrow("dynamic flow-control depth");
    });

    test("plans stable, branch-local, and uniform-bank texture samples", () => {
        const stableSample = instruction(Op.TEX, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)]);
        const stableBlocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            stableSample,
            instruction(Op.ENDIF),
        ]));
        const stableCensus = new Census();
        const stablePlan = planUniformity(stableBlocks, { census: stableCensus });
        expect(stablePlan.sampleFor(stableSample)).toMatchObject({
            mode: "grad",
            divergent: true,
            coordinateSafety: "stable",
            censusStatus: "ok",
            derivative: { anchorPath: [0] },
        });
        expect(stableCensus.summary()).toMatchObject({ total: 1, approximated: 0 });

        const branchLocalSample = instruction(Op.TEX, [source(RegType.TEMP, 0), source(RegType.SAMPLER, 0)]);
        const branchLocalBlocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            instruction(Op.MOV, [source(RegType.INPUT, 1)], 0, destination(RegType.TEMP, 0)),
            branchLocalSample,
            instruction(Op.ENDIF),
        ]));
        const branchLocalCensus = new Census();
        const branchLocalPlan = planUniformity(branchLocalBlocks, { census: branchLocalCensus });
        expect(branchLocalPlan.sampleFor(branchLocalSample)).toMatchObject({
            mode: "grad",
            coordinateSafety: "branch-local",
            reason: "branch-local-coordinate",
            censusStatus: "ok",
            derivative: {
                coordinateExpression: {
                    kind: "source",
                    source: { reg: { type: RegType.INPUT, num: 1 } },
                },
            },
        });
        expect(branchLocalCensus.summary()).toMatchObject({ total: 1, approximated: 0, unsupported: 0 });

        const uniformSample = instruction(Op.TEX, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)]);
        const uniformBlocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.CONSTBOOL, 0)]),
            uniformSample,
            instruction(Op.ENDIF),
        ]));
        expect(planUniformity(uniformBlocks).sampleFor(uniformSample)).toMatchObject({
            mode: "implicit",
            divergent: false,
            reason: "uniform-control",
        });
    });

    test("keeps planned WGSL samples compatible with the common sampler and 2D/cube bindings", () => {
        const stableSample = instruction(Op.TEX, [source(RegType.INPUT, 0), source(RegType.SAMPLER, 0)]);
        const stableBlocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            stableSample,
            instruction(Op.ENDIF),
        ]));
        const stable = planUniformity(stableBlocks).sampleFor(stableSample)!;

        const unsafeSample = instruction(Op.TEX, [source(RegType.TEMP, 0), source(RegType.SAMPLER, 1)]);
        const unsafeBlocks = structureProgram(program([
            instruction(Op.IF, [source(RegType.TEMP, 7)]),
            instruction(Op.MUL, [source(RegType.INPUT, 1), source(RegType.INPUT, 2)], 0, destination(RegType.TEMP, 0)),
            unsafeSample,
            instruction(Op.ENDIF),
        ]));
        const unsafeCensus = new Census();
        const unsafe = planUniformity(unsafeBlocks, { census: unsafeCensus }).sampleFor(unsafeSample)!;
        expect(unsafe).toMatchObject({
            mode: "refuse",
            censusStatus: "unsupported",
            coordinateSafety: "branch-local",
        });
        expect(unsafeCensus.summary()).toMatchObject({ total: 1, unsupported: 1, approximated: 0 });

        const emitter = new Emitter();
        emitter.line("@group(0) @binding(2) var samp: sampler;");
        emitter.line("@group(0) @binding(3) var tex0: texture_2d<f32>;");
        emitter.line("@group(0) @binding(4) var tex1: texture_cube<f32>;");
        emitter.open("@fragment fn main()");
        emitter.line("let uv = vec2<f32>(0.0, 0.0);");
        const derivatives = emitSampleDerivatives(emitter, "uv");
        emitter.open("if (varying)");
        emitter.line(`let color2d = ${emitTextureSample({ stage: 0, coordinate: "uv", plan: stable }, derivatives)};`);
        expect(() => emitTextureSample({
            stage: 1,
            coordinate: "vec3<f32>(0.0, 0.0, 1.0)",
            plan: unsafe,
        }, undefined)).toThrow("refusing link instead of substituting LOD 0");
        emitter.close();
        emitter.close();
        const plannedWgsl = emitter.toString();

        expect(plannedWgsl).toBe([
            "@group(0) @binding(2) var samp: sampler;",
            "@group(0) @binding(3) var tex0: texture_2d<f32>;",
            "@group(0) @binding(4) var tex1: texture_cube<f32>;",
            "@fragment fn main() {",
            "    let uv = vec2<f32>(0.0, 0.0);",
            "    let _ddx0 = dpdx(uv);",
            "    let _ddy1 = dpdy(uv);",
            "    if (varying) {",
            "        let color2d = textureSampleGrad(tex0, samp, uv, _ddx0, _ddy1);",
            "    }",
            "}",
        ].join("\n"));
    });

    test("wgslCheck rejects the baseline implicit sample and accepts the planned seam", async () => {
        const system = System.getInstance();
        const previous = system.services.render.getBackend();
        const fakeDevice = {
            createShaderModule: ({ code }: { code: string }) => ({
                getCompilationInfo: async () => ({
                    messages: /\bif\s*\([^)]*\)\s*\{[\s\S]*textureSample\(/.test(code) ? [{
                        type: "error", message: "implicit texture sample in divergent control flow",
                        lineNum: 1, linePos: 1, offset: 0, length: 1,
                    }] : [],
                }),
            }),
        };
        system.services.render.setBackend({ kind: "webgpu", getDevice: () => fakeDevice } as never);
        try {
            const service = new StubHarnessService();
            registerShaderCommands(service as never);
            const check = service.handlers.get("wgslCheck")!;
            const baseline = await check([{ wgsl: [
                "@fragment fn main() {",
                "    if (varying) {",
                "        let color = textureSample(tex0, samp, uv);",
                "    }",
                "}",
            ].join("\n") }], {});
            expect(baseline).toMatchObject({ ok: false });

            const clean = await check([{ wgsl: [
                "@fragment fn main() {",
                "    let ddx = dpdx(uv);",
                "    let ddy = dpdy(uv);",
                "    if (varying) {",
                "        let color = textureSampleGrad(tex0, samp, uv, ddx, ddy);",
                "    }",
                "}",
            ].join("\n") }], {});
            expect(clean).toMatchObject({ ok: true, messages: [] });
        } finally {
            system.services.render.setBackend(previous as never);
        }
    });
});
