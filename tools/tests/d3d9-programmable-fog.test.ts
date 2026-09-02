/** W10 acceptance: live D3D fixed-function fog after programmable ps_1_x/ps_2_x. */
import { describe, expect, test } from "bun:test";
import { resolveProgrammablePixelFogMode } from "../../src/worker/backends/webgpu/d3d9/ffp-fog";
import { analyzePs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/ps";
import { analyzeVs } from "../../src/worker/backends/webgpu/d3d9/shader/emit/vs";
import { linkProgram, type CompiledPs, type CompiledVs } from "../../src/worker/backends/webgpu/d3d9/shader/link";
import { Op, RegType, RASTOUT_FOG, RASTOUT_POS } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import type { SmInstruction, SmProgram, SmSource } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";

const IDENTITY = 0xe4;

function source(type: RegType, num: number): SmSource {
    return { reg: { type, num, relative: false }, swizzle: IDENTITY, modifier: 0 };
}

function mov(dstType: RegType, dstNum: number, srcType = RegType.CONST, srcNum = 0): SmInstruction {
    return {
        opcode: Op.MOV,
        coissue: false,
        predicated: false,
        specificData: 0,
        comparison: undefined,
        dst: {
            reg: { type: dstType, num: dstNum, relative: false },
            writeMask: 0xf,
            shift: 0,
            saturate: false,
            partialPrecision: false,
            centroid: false,
        },
        src: [source(srcType, srcNum)],
    };
}

function program(isPixelShader: boolean, major: number, instructions: SmInstruction[]): SmProgram {
    return {
        isPixelShader,
        major,
        minor: 0,
        instructions,
        declarations: [],
        definitions: [],
        maxTemp: -1,
        maxConst: 0,
        maxBool: -1,
        samplersUsed: new Set(),
        inputRegs: new Set(),
        usesRelativeConst: false,
        stream: [],
        tokenCount: 0,
        terminated: true,
    };
}

function compiledVs(writesFog: boolean): CompiledVs {
    const prog = program(false, 2, [
        mov(RegType.RASTOUT, RASTOUT_POS),
        ...(writesFog ? [mov(RegType.RASTOUT, RASTOUT_FOG)] : []),
    ]);
    return { prog, analysis: analyzeVs(prog) };
}

function compiledPs(major: number): CompiledPs {
    const prog = program(true, major, [mov(RegType.COLOROUT, 0)]);
    return { prog, analysis: analyzePs(prog) };
}

function link(vs: CompiledVs, ps: CompiledPs, preTransformed = false): string {
    return linkProgram({
        vs,
        ps,
        declElements: preTransformed ? [
            { stream: 0, offset: 0, type: 3, usage: 9, usageIndex: 0 }, // FLOAT4 POSITIONT
            { stream: 0, offset: 16, type: 4, usage: 10, usageIndex: 1 }, // D3DCOLOR COLOR1
        ] : null,
        streamStride: preTransformed ? 20 : 16,
        preTransformed: preTransformed
            ? { viewportWidth: 640, viewportHeight: 480, pixelCenterOffset: 0.5 }
            : null,
    }).wgsl;
}

describe("D3D9 programmable fixed-function fog (W10)", () => {
    test("resolves live table fog ahead of the programmable VS fog factor", () => {
        expect(resolveProgrammablePixelFogMode(0, 3)).toBe(0);
        expect(resolveProgrammablePixelFogMode(1, 0)).toBe(0.5);
        expect(resolveProgrammablePixelFogMode(1, 2)).toBe(2);
    });

    test("links PS2 to live fog uniforms and the VS oFog interpolant", () => {
        const wgsl = link(compiledVs(true), compiledPs(2));
        expect(wgsl).toContain("fogColor: vec4<f32>, fogParams: vec4<f32>");
        expect(wgsl).toContain("@location(10) fog: f32");
        expect(wgsl).toContain("out.fog = clamp((oFog)[0], 0.0, 1.0)");
        expect(wgsl).toContain("if (psc.fogParams.w > 0.0)");
        expect(wgsl).toContain("((in.pos).z / max((in.pos).w, 1e-8))");
        expect(wgsl).toContain("in.fog, 0.0);");
        expect(wgsl).toContain("vec4<f32>(mix(vec3<f32>(oC0[0], oC0[1], oC0[2]), (psc.fogColor).rgb, _psFogFactor), oC0[3])");
    });

    test("defaults an unwritten programmable oFog to fully unfogged", () => {
        const wgsl = link(compiledVs(false), compiledPs(2));
        expect(wgsl).toContain("out.fog = 1.0");
    });

    test("does not add fixed-function fog to PS3", () => {
        const wgsl = link(compiledVs(true), compiledPs(3));
        expect(wgsl).not.toContain("@location(10) fog: f32");
        expect(wgsl).not.toContain("_psFogFactor");
        expect(wgsl).not.toContain("fn ffpFogFactor(");
    });

    test("programmable point expansion defaults and clamps oPts through hidden c[] state", () => {
        const wgsl = linkProgram({
            vs: compiledVs(false),
            ps: compiledPs(3),
            declElements: null,
            streamStride: 16,
            pointExpansion: true,
        }).wgsl;
        expect(wgsl).toContain("var oPts: vec4<f32> = vec4<f32>(vsc.c[2].x, 0.0, 0.0, 0.0)");
        expect(wgsl).toContain("let _pointSize = clamp(oPts[0], vsc.c[2].y, vsc.c[2].z)");
        expect(wgsl).toContain("let _pointCorner = vertexIndex % 6u");
    });

    test("POSITIONT preserves RHW, clamps z, and applies the D3D9 pixel center", () => {
        const wgsl = link(compiledVs(false), compiledPs(2), true);
        expect(wgsl).toContain("let _clipW = select(1.0, 1.0 / _rhw, _rhw != 0.0)");
        expect(wgsl).toContain("((_p.x + 0.5) / 640.0)");
        expect(wgsl).toContain("((_p.y + 0.5) / 480.0)");
        expect(wgsl).toContain("clamp(_p.z, 0.0, 1.0) * _clipW");
    });

    test("POSITIONT vertex fog still comes from specular alpha", () => {
        const wgsl = link(compiledVs(false), compiledPs(2), true);
        expect(wgsl).toContain("out.fog = clamp(((in.v2).zyxw).a, 0.0, 1.0)");
    });

    test("evaluates ADD targeting oFog before forced saturation", () => {
        const prog = program(false, 2, [
            mov(RegType.RASTOUT, RASTOUT_POS),
            {
                ...mov(RegType.RASTOUT, RASTOUT_FOG),
                opcode: Op.ADD,
                src: [source(RegType.CONST, 0), source(RegType.CONST, 1)],
            },
        ]);
        prog.maxConst = 1;
        const wgsl = link({ prog, analysis: analyzeVs(prog) }, compiledPs(2));
        expect(wgsl).toContain("// add");
        expect(wgsl).toContain("let _sat1 = (vec4<f32>(vsc.c[0]) + vec4<f32>(vsc.c[1]));");
        expect(wgsl).toContain("min(max(_sat1, vec4<f32>(0.0)), vec4<f32>(1.0))");
        expect(wgsl).not.toContain("let _st1 = min(max(vsc.c[0],");
    });

    test("lowers programmable user clip planes through clip-space distances", () => {
        const wgsl = linkProgram({
            vs: compiledVs(false),
            ps: compiledPs(3),
            declElements: null,
            streamStride: 16,
            clipPlanes: true,
        }).wgsl;
        // compiledVs uses c0; c1 is the pixel-centre sidecar, c2 is the point-size sidecar,
        // and c3..c8 are the six raw D3D9 clip-plane equations.
        expect(wgsl).toContain("clipA: vec4<f32>");
        expect(wgsl).toContain("clipB: vec2<f32>");
        expect(wgsl).toContain("dot(_clipPlanePos, vsc.c[3])");
        expect(wgsl).toContain("dot(_clipPlanePos, vsc.c[8])");
        expect(wgsl).toContain("in.clipA.x < 0.0");
    });

    test("keeps programmable clip varyings distinct from the PS2 fog varying", () => {
        const wgsl = linkProgram({
            vs: compiledVs(true),
            ps: compiledPs(2),
            declElements: null,
            streamStride: 16,
            clipPlanes: true,
        }).wgsl;
        expect(wgsl).toContain("@location(10) fog: f32");
        expect(wgsl).toContain("@location(11) clipA: vec4<f32>");
        expect(wgsl).toContain("@location(12) clipB: vec2<f32>");
    });

    test("does not add clip varyings to a pre-transformed vertex link", () => {
        const wgsl = link(compiledVs(false), compiledPs(3), true);
        expect(wgsl).not.toContain("clipA: vec4<f32>");
        expect(wgsl).not.toContain("in.clipA.x < 0.0");
    });
});
