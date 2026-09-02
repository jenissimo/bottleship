/** Focused W6 acceptance: PS3 builtins, depth output, texkill masks and semantic linkage. */
import { describe, expect, test } from "bun:test";
import {
    compilePixelShader,
    compileVertexShader,
    linkProgram,
    type RawVertexElement,
} from "../../src/worker/backends/webgpu/d3d9/shader/index";
import { Op, RegType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { Logger, LogCategory } from "../../src/worker/core/logger";

const SWZ_IDENTITY = 0xE4;
const END = 0x0000FFFF;

function regBits(type: number, num: number): number {
    return (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | (num & 0x7FF)) >>> 0;
}
function version(isPs: boolean, major: number, minor: number): number {
    return (((isPs ? 0xFFFF : 0xFFFE) << 16) | (major << 8) | minor) >>> 0;
}
function instr(op: number, operands = 0): number {
    return (op | (operands << 24)) >>> 0;
}
function dst(type: number, num: number, mask = 0xF): number {
    return (regBits(type, num) | (mask << 16)) >>> 0;
}
function src(type: number, num: number, swizzle = SWZ_IDENTITY): number {
    return (regBits(type, num) | (swizzle << 16)) >>> 0;
}
function dclReg(usage: number, usageIndex: number, type: number, num: number): number[] {
    return [instr(Op.DCL, 2), (usage | (usageIndex << 16)) >>> 0, regBits(type, num)];
}
function simpleVs3(outputUsage = Usage.POSITION, outputIndex = 0, outputReg = 0): Uint32Array {
    return new Uint32Array([
        version(false, 3, 0),
        ...dclReg(Usage.POSITION, 0, RegType.INPUT, 0),
        ...dclReg(outputUsage, outputIndex, RegType.OUTPUT, outputReg),
        instr(Op.MOV, 2), dst(RegType.OUTPUT, outputReg), src(RegType.INPUT, 0),
        END,
    ]);
}
function semanticVs3(semantics: Array<[number, number]>): Uint32Array {
    return new Uint32Array([
        version(false, 3, 0),
        ...dclReg(Usage.POSITION, 0, RegType.INPUT, 0),
        ...dclReg(Usage.POSITION, 0, RegType.OUTPUT, 0),
        ...semantics.flatMap(([usage, index], i) => dclReg(usage, index, RegType.OUTPUT, i + 1)),
        instr(Op.MOV, 2), dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
        ...semantics.flatMap((_semantic, i) => [
            instr(Op.MOV, 2), dst(RegType.OUTPUT, i + 1), src(RegType.INPUT, 0),
        ]),
        END,
    ]);
}
const positionDecl: RawVertexElement[] = [
    { stream: 0, offset: 0, type: 2, usage: Usage.POSITION, usageIndex: 0 },
];

function fragmentBody(wgsl: string): string {
    const start = wgsl.indexOf("@fragment\nfn fs_main");
    return start >= 0 ? wgsl.slice(start) : wgsl;
}

describe("D3D9 PS3 I/O (W6)", () => {
    test("vPos/vFace/oDepth generate distinct PS input/output builtins", () => {
        const psTokens = new Uint32Array([
            version(true, 3, 0),
            ...dclReg(0, 0, RegType.MISCTYPE, 0), // vPos
            ...dclReg(0, 0, RegType.MISCTYPE, 1), // vFace
            instr(Op.ADD, 3), dst(RegType.TEMP, 0), src(RegType.MISCTYPE, 0), src(RegType.MISCTYPE, 1),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0),
            instr(Op.MOV, 2), dst(RegType.DEPTHOUT, 0), src(RegType.TEMP, 0),
            END,
        ]);
        const result = linkProgram({
            vs: compileVertexShader(simpleVs3()),
            ps: compilePixelShader(psTokens),
            declElements: positionDecl,
            streamStride: 12,
        });
        const body = fragmentBody(result.wgsl);

        // The old fallback was a flat vec4(0); these expressions make the change
        // observable in the generated fixture rather than merely testing metadata.
        expect(body).toContain("vec4<f32>((in.pos).xy - vec2<f32>(0.5), (in.pos).zw)");
        expect(body).toContain("select(vec4<f32>(-1.0), vec4<f32>(1.0), in.frontFacing)");
        expect(body).not.toContain("return vec4<f32>(0.0)");
        expect(result.wgsl).toContain("@builtin(front_facing) frontFacing: bool,");
        expect(result.wgsl).toContain("@builtin(frag_depth) depth: f32,");
        expect(body).toContain("oDepth = min(max(");
        expect(body).toContain("out.depth = oDepth;");
        expect(body).not.toContain("oC1");

        // Generated-WGSL snapshot for the narrow PS3 I/O seam.
        expect(body).toMatchSnapshot();
    });

    test("PS2+ texkill observes the destination mask, while PS1.1-1.3 stays xyz", () => {
        const ps2 = new Uint32Array([
            version(true, 2, 0),
            instr(Op.MOV, 2), dst(RegType.TEMP, 0), src(RegType.CONST, 0),
            instr(Op.TEXKILL, 1), dst(RegType.TEMP, 0, 0x1),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0),
            END,
        ]);
        const ps2Wgsl = linkProgram({
            vs: compileVertexShader(semanticVs3([[Usage.TEXCOORD, 8]])),
            ps: compilePixelShader(ps2),
            declElements: positionDecl,
            streamStride: 12,
        }).wgsl;
        expect(ps2Wgsl).toContain("if ((r0)[0] < 0.0) { discard; }");
        expect(ps2Wgsl).not.toContain("(r0).y < 0.0");
        expect(ps2Wgsl).not.toContain("(r0).z < 0.0");

        const ps11 = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEXKILL), dst(RegType.TEXTURE, 0),
            END,
        ]);
        const ps11Wgsl = linkProgram({
            vs: compileVertexShader(new Uint32Array([version(false, 1, 1), END])),
            ps: compilePixelShader(ps11),
            declElements: null,
            streamStride: null,
        }).wgsl;
        expect(ps11Wgsl).toContain("(in.tex0)[0] < 0.0");
        expect(ps11Wgsl).toContain("(in.tex0)[1] < 0.0");
        expect(ps11Wgsl).toContain("(in.tex0)[2] < 0.0");
        expect(ps11Wgsl).not.toContain("(in.tex0)[3] < 0.0");
    });

    test("declared non-color semantic links through a named interpolant", () => {
        const psTokens = new Uint32Array([
            version(true, 3, 0),
            ...dclReg(Usage.NORMAL, 0, RegType.INPUT, 3),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.INPUT, 3),
            END,
        ]);
        const result = linkProgram({
            vs: compileVertexShader(simpleVs3(Usage.NORMAL, 0, 2)),
            ps: compilePixelShader(psTokens),
            declElements: positionDecl,
            streamStride: 12,
        });
        expect(result.wgsl).toContain("@location(2) tex0: vec4<f32>");
        expect(result.wgsl).toContain("out.tex0 = oT0;");
        expect(result.wgsl).toContain("in.tex0");
        expect(result.wgsl).not.toContain("in.col3");
        expect(result.wgsl).not.toContain("vec4<f32>(0.0);\n    let _st");
    });

    test("a vs_3_0 generic output semantic links with no matching PS declaration", () => {
        // The linker's semantic repair only fires when a PS declares the same
        // usage. Without one, the vertex stage must place `dcl_normal o1` on the
        // very slot mapPsInputSemantic would have given it, not drop the write
        // and refuse a legal shader.
        const result = linkProgram({
            vs: compileVertexShader(semanticVs3([[Usage.NORMAL, 0]])),
            ps: null,
            declElements: positionDecl,
            streamStride: 12,
        });
        expect(result.census.vs.unsupportedOps).toEqual([]);
        expect(result.wgsl).toContain("oT10");
    });

    test("allocates simultaneous formerly-colliding generic semantics to unique slots", () => {
        const semantics: Array<[number, number]> = [
            [Usage.BLENDWEIGHT, 0],
            [Usage.FOG, 0],
            [Usage.NORMAL, 0],
            [Usage.TEXCOORD, 10],
        ];
        const psTokens = new Uint32Array([
            version(true, 3, 0),
            ...semantics.flatMap(([usage, index], reg) => dclReg(usage, index, RegType.INPUT, reg)),
            instr(Op.ADD, 3), dst(RegType.TEMP, 0), src(RegType.INPUT, 0), src(RegType.INPUT, 1),
            instr(Op.ADD, 3), dst(RegType.TEMP, 0), src(RegType.TEMP, 0), src(RegType.INPUT, 2),
            instr(Op.ADD, 3), dst(RegType.TEMP, 0), src(RegType.TEMP, 0), src(RegType.INPUT, 3),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0),
            END,
        ]);
        const result = linkProgram({
            vs: compileVertexShader(semanticVs3(semantics)),
            ps: compilePixelShader(psTokens),
            declElements: positionDecl,
            streamStride: 12,
        });
        for (let slot = 0; slot < semantics.length; slot++) {
            expect(result.wgsl).toContain(`@location(${2 + slot}) tex${slot}: vec4<f32>`);
            expect(result.wgsl).toContain(`out.tex${slot} = oT${slot};`);
            expect(fragmentBody(result.wgsl)).toContain(`in.tex${slot}`);
        }
        const interpLocations = [...result.wgsl.matchAll(/struct Interp \{[\s\S]*?\n\}/g)][0]?.[0]
            .match(/@location\((\d+)\)/g) ?? [];
        expect(new Set(interpLocations).size).toBe(interpLocations.length);
    });

    test("moves programmable fog when TEXCOORD8 occupies the legacy fog location", () => {
        const psTokens = new Uint32Array([
            version(true, 2, 0),
            ...dclReg(Usage.TEXCOORD, 8, RegType.INPUT, 0),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.INPUT, 0),
            END,
        ]);
        const result = linkProgram({
            vs: compileVertexShader(semanticVs3([[Usage.TEXCOORD, 8]])),
            ps: compilePixelShader(psTokens),
            declElements: positionDecl,
            streamStride: 12,
        });
        const interp = result.wgsl.match(/struct Interp \{[\s\S]*?\n\}/)?.[0] ?? "";
        expect(interp).toContain("@location(10) tex8: vec4<f32>");
        expect(interp).toContain("@location(11) fog: f32");
        expect([...interp.matchAll(/@location\((\d+)\)/g)].map(match => match[1])).toEqual(["0", "10", "11"]);
    });

    test("interpolant overflow is retained for diagnostics but marked unbindable", () => {
        // The global recent-entry ring is intentionally only 50 entries and the full
        // suite runs files concurrently.  Observe the diagnostic through the lossless
        // tap so unrelated tests cannot evict this warning before the assertion.
        let budgetWarning = false;
        const tap = (entry: { category: LogCategory; message: string }) => {
            if (entry.category === LogCategory.D3D9 && entry.message.includes("interpolant budget")) {
                budgetWarning = true;
            }
        };
        Logger.addLogTap(tap);
        const inputs = Array.from({ length: 16 }, (_, reg) => reg);
        const psTokens = new Uint32Array([
            version(true, 3, 0),
            ...inputs.flatMap(reg => dclReg(Usage.TEXCOORD, reg, RegType.INPUT, reg)),
            instr(Op.MOV, 2), dst(RegType.TEMP, 0), src(RegType.INPUT, 0),
            ...inputs.slice(1).flatMap(reg => [
                instr(Op.ADD, 3), dst(RegType.TEMP, 0), src(RegType.TEMP, 0), src(RegType.INPUT, reg),
            ]),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.TEMP, 0),
            END,
        ]);
        let result: ReturnType<typeof linkProgram>;
        try {
            result = linkProgram({
                vs: compileVertexShader(simpleVs3()),
                ps: compilePixelShader(psTokens),
                declElements: positionDecl,
                streamStride: 12,
            });
        } finally {
            Logger.removeLogTap(tap);
        }
        expect(result.wgsl).toContain("@location(17) tex15: vec4<f32>");
        expect(result.interpolantBudgetExceeded).toBe(true);
        expect(budgetWarning).toBe(true);
    });
});
