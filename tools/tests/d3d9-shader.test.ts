/**
 * D3D9 SM1.x → WGSL recompiler tests.
 *
 * Hand-assembles known vs_1_1 / ps_1_1 token streams (including the CTAB
 * comment block fxc emits after the version token — the original NFS Underground
 * `Unknown VS opcode 0xfffe` crash) and verifies parsing + WGSL codegen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import {
    compileVertexShader, compilePixelShader, linkProgram, RawVertexElement,
} from "../../src/worker/backends/webgpu/d3d9/shader/index";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import { pixelCenterClipOffset } from "../../src/worker/backends/webgpu/pixel-center";
import { emitTextureSample } from "../../src/worker/backends/webgpu/d3d9/shader/emit/tex";
import type { SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";
import legacyTextureOracle from "./fixtures/d3d9-legacy-texture-oracle.json";

const PIXEL_CENTRE_KILL_SWITCH = "__d3dNoPixelCentre";
afterEach(() => delete (globalThis as Record<string, unknown>)[PIXEL_CENTRE_KILL_SWITCH]);

const sampleSpec = (over: Partial<SamplerSpec> = {}): SamplerSpec => ({
    min: "linear",
    mag: "linear",
    mip: "linear",
    mipNone: false,
    addressU: "repeat",
    addressV: "repeat",
    addressW: "repeat",
    ...over,
});

describe("shader-side D3D9 sampler semantics", () => {
    test("emits BORDER selection and preserves the packed ARGB colour", () => {
        const expr = emitTextureSample({
            stage: 0,
            coordinate: "uv",
            samplerSpec: sampleSpec({ addressU: "d3d9-border", borderColor: 0x80402010 }),
        });
        expect(expr).toContain("clamp((uv).x, 0.0, 1.0)");
        expect(expr).toContain("select(textureSample(tex0, samp");
        expect(expr).toContain("0.25098039215686274");
        expect(expr).toContain("0.5019607843137255");
    });

    test("emits MIRRORONCE independently per coordinate axis", () => {
        const expr = emitTextureSample({
            stage: 1,
            coordinate: "uvw",
            dimensions: 3,
            samplerSpec: sampleSpec({
                addressV: "d3d9-mirror-once",
                addressW: "d3d9-border",
            }),
        });
        expect(expr).toContain("clamp(abs((uvw).y), 0.0, 1.0)");
        expect(expr).toContain("clamp((uvw).z, 0.0, 1.0)");
        expect(expr).toContain("(uvw).z < 0.0 || (uvw).z > 1.0");
    });

    test("applies LOD bias to explicit level and explicit gradients", () => {
        const spec = sampleSpec({ mipLodBias: 1 });
        const level = emitTextureSample({ stage: 0, coordinate: "uv", mode: "level", level: "lod", samplerSpec: spec });
        const implicit = emitTextureSample({ stage: 0, coordinate: "uv", samplerSpec: spec });
        const grad = emitTextureSample({
            stage: 0,
            coordinate: "uv",
            mode: "grad",
            samplerSpec: spec,
            sampler: "samp0",
            texture: "tex0",
        }, { ddx: "dx", ddy: "dy" });
        expect(level).toContain("textureSampleLevel(tex0, samp, uv, ((lod) + 1.0))");
        expect(implicit).toContain("textureSampleBias(tex0, samp, uv, 1.0)");
        expect(grad).toContain("exp2(1.0)");
        expect(grad).toContain("textureSampleGrad(tex0, samp0, uv");
    });

    test("lowers comparison-sampler bias and explicit gradients to compare-level", () => {
        const spec = sampleSpec({ mipLodBias: 1 });
        const biased = emitTextureSample({
            stage: 0,
            coordinate: "uv",
            depthCoordinate: "uvz",
            comparison: true,
            samplerSpec: spec,
        });
        const grad = emitTextureSample({
            stage: 0,
            coordinate: "uv",
            depthCoordinate: "uvz",
            comparison: true,
            mode: "grad",
            samplerSpec: sampleSpec(),
        }, { ddx: "dx", ddy: "dy" });
        expect(biased).toContain("textureSampleCompareLevel(tex0, samp, uv, ((uvz).z)");
        expect(biased).toContain("textureDimensions(tex0)");
        expect(biased).toContain("textureNumLevels(tex0)");
        expect(biased).not.toContain("textureSampleCompare(tex0, samp");
        expect(grad).toContain("textureSampleCompareLevel(tex0, samp, uv, ((uvz).z)");
        expect(grad).toContain("(dx)");
        expect(grad).toContain("(dy)");
    });

    test("does not alter cube direction coordinates for custom address modes", () => {
        const expr = emitTextureSample({
            stage: 0,
            coordinate: "dir",
            dimensions: 3,
            cube: true,
            samplerSpec: sampleSpec({ addressU: "d3d9-border", addressV: "d3d9-mirror-once" }),
        });
        expect(expr).toBe("textureSample(tex0, samp, dir)");
        expect(expr).not.toContain("clamp");
    });
});

// ── Token encoders (mirror the decoder in sm-parser.ts) ───────────────────────

const SWZ_IDENTITY = 0xE4; // x,y,z,w

function regBits(type: number, num: number): number {
    return (((type & 0x7) << 28) | (((type >>> 3) & 0x3) << 11) | (num & 0x7FF)) >>> 0;
}
function version(isPs: boolean, major: number, minor: number): number {
    return (((isPs ? 0xFFFF : 0xFFFE) << 16) | (major << 8) | minor) >>> 0;
}
function instr(op: number, opts: { coissue?: boolean; data?: number } = {}): number {
    return (op | ((opts.data ?? 0) << 16) | (opts.coissue ? 0x40000000 : 0)) >>> 0;
}
function dst(type: number, num: number, mask = 0xF, shift = 0, sat = false): number {
    return (regBits(type, num) | (mask << 16) | ((shift & 0xF) << 24) | (sat ? (1 << 20) : 0)) >>> 0;
}
function src(type: number, num: number, swizzle = SWZ_IDENTITY, mod = 0, relative = false): number {
    return (regBits(type, num) | (swizzle << 16) | ((mod & 0xF) << 24) | (relative ? (1 << 13) : 0)) >>> 0;
}
function comment(dwords: number[]): number[] {
    return [(0xFFFE | (dwords.length << 16)) >>> 0, ...dwords];
}
function dcl(usage: number, usageIndex: number, num: number): number[] {
    // dcl destination is always an input register (v#); the data type lives in
    // the separate vertex declaration, not the shader bytecode.
    return [instr(Op.DCL), (usage | (usageIndex << 16)) >>> 0, regBits(RegType.INPUT, num)];
}
function dclReg(usage: number, usageIndex: number, type: number, num: number): number[] {
    // SM2+ carries the two operand DWORDs in the instruction length nibble.
    return [(Op.DCL | (2 << 24)) >>> 0, (usage | (usageIndex << 16)) >>> 0, regBits(type, num)];
}
function def(num: number, x: number, y: number, z: number, w: number): number[] {
    const f = new Float32Array([x, y, z, w]);
    const u = new Uint32Array(f.buffer);
    return [instr(Op.DEF), regBits(RegType.CONST, num), u[0], u[1], u[2], u[3]];
}
const END = 0x0000FFFF;

describe("shader destination and declaration refusal", () => {
    test("records an invalid ALU destination as unsupported instead of a successful no-op", () => {
        const invalidDestination = compileVertexShader(new Uint32Array([
            version(false, 3, 0),
            (2 << 24) | Op.MOV,
            dst(RegType.CONST, 0),
            src(RegType.INPUT, 0),
            END,
        ]));
        expect(() => linkProgram({
            vs: invalidDestination,
            ps: null,
            declElements: [{ stream: 0, offset: 0, type: 3, usage: 0, usageIndex: 0 }],
            streamStride: 16,
        })).toThrow(/Unsupported .* opcode mov/);
    });

    test("refuses packed 10-bit declaration types instead of fabricating float32x4", () => {
        const vs = compileVertexShader(buildVs());
        expect(() => linkProgram({
            vs,
            ps: null,
            declElements: [
                { stream: 0, offset: 0, type: 13, usage: 0, usageIndex: 0 }, // UDEC3
                { stream: 0, offset: 4, type: 1, usage: 5, usageIndex: 0 },
            ],
            streamStride: 12,
        })).toThrow(/unsupported D3DDECLTYPE 13/);
    });

    test("does not invent an attribute for a declared input missing from the vertex declaration", () => {
        const vs = compileVertexShader(buildVs());
        const linked = linkProgram({
            vs,
            ps: null,
            declElements: [{ stream: 0, offset: 0, type: 3, usage: 0, usageIndex: 0 }],
            streamStride: 16,
        });
        expect(linked.vertexAttributes).toHaveLength(1);
        expect(linked.wgsl).toContain("vec4<f32>(0.0)");
    });
});

// A minimal world-transform vs_1_1 with a CTAB comment, a dcl, a def and a m4x4.
function buildVs(): Uint32Array {
    return new Uint32Array([
        version(false, 1, 1),
        ...comment([0x42415443, 0x0, 0x1, 0x2]), // fake "CTAB" block — must be skipped
        ...dcl(0 /*POSITION*/, 0, 0 /*v0*/),
        ...dcl(5 /*TEXCOORD*/, 0, 1 /*v1*/),
        ...def(4, 1, 1, 1, 1),
        // dp4 oPos.x/y/z/w, v0, c0..c3
        instr(Op.DP4), dst(RegType.RASTOUT, 0, 0x1), src(RegType.INPUT, 0), src(RegType.CONST, 0),
        instr(Op.DP4), dst(RegType.RASTOUT, 0, 0x2), src(RegType.INPUT, 0), src(RegType.CONST, 1),
        instr(Op.DP4), dst(RegType.RASTOUT, 0, 0x4), src(RegType.INPUT, 0), src(RegType.CONST, 2),
        instr(Op.DP4), dst(RegType.RASTOUT, 0, 0x8), src(RegType.INPUT, 0), src(RegType.CONST, 3),
        // mov oT0, v1   /   mov oD0, c4
        instr(Op.MOV), dst(RegType.TEXCRDOUT, 0), src(RegType.INPUT, 1),
        instr(Op.MOV), dst(RegType.ATTROUT, 0), src(RegType.CONST, 4),
        END,
    ]);
}

// A ps_1_1: sample stage 0, modulate by diffuse.
function buildPs(): Uint32Array {
    return new Uint32Array([
        version(true, 1, 1),
        ...comment([0xCAFE]),
        instr(Op.TEX), dst(RegType.TEXTURE, 0),
        instr(Op.MUL), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 0), src(RegType.INPUT, 0),
        END,
    ]);
}

describe("sm-parser", () => {
    test("decodes register type split correctly", () => {
        // CONST type=2 must decode to 2 (not 8) — the bit-split gotcha.
        const token = regBits(RegType.CONST, 5);
        const prog = parseShader(new Uint32Array([
            version(false, 1, 1),
            instr(Op.MOV), dst(RegType.TEMP, 0), token >>> 0,
            END,
        ]));
        expect(prog.instructions[0].src[0].reg.type).toBe(RegType.CONST);
        expect(prog.instructions[0].src[0].reg.num).toBe(5);
    });

    test("skips the CTAB comment block (the NFSU 0xfffe crash)", () => {
        const prog = parseShader(buildVs());
        expect(prog.isPixelShader).toBe(false);
        expect(prog.major).toBe(1);
        expect(prog.minor).toBe(1);
        // 4 dp4 + 2 mov = 6 real instructions; dcl/def are separate.
        expect(prog.instructions.length).toBe(6);
        expect(prog.declarations.length).toBe(2);
        expect(prog.definitions.length).toBe(1);
        expect(prog.maxConst).toBe(4);
    });

    test("parses ps_1_1 tex + sampler tracking", () => {
        const prog = parseShader(buildPs());
        expect(prog.isPixelShader).toBe(true);
        expect(prog.instructions.length).toBe(2);
        expect([...prog.samplersUsed]).toEqual([0]);
    });

    test("throws on garbage version", () => {
        expect(() => parseShader(new Uint32Array([0x12345678, END]))).toThrow();
    });

    test("rejects shader-model versions outside the D3D9 1.x-3.x range", () => {
        expect(() => parseShader(new Uint32Array([
            version(false, 4, 0), END,
        ]))).toThrow(/unsupported shader model/);
    });

    test("decodes dst write mask, shift and saturate", () => {
        const prog = parseShader(new Uint32Array([
            version(true, 1, 1),
            instr(Op.MOV), dst(RegType.TEMP, 0, 0x3, 1 /*_x2*/, true /*_sat*/), src(RegType.TEMP, 1),
            END,
        ]));
        const d = prog.instructions[0].dst!;
        expect(d.writeMask).toBe(0x3);
        expect(d.shift).toBe(1);
        expect(d.saturate).toBe(true);
    });

    test("rejects a predicated instruction whose predicate token is not p0", () => {
        // SM3 length counts destination + predicate + source.  A TEMP token in
        // the predicate slot must not be accepted as an arbitrary boolean source.
        const predicatedMov = (Op.MOV | (3 << 24) | 0x10000000) >>> 0;
        expect(() => parseShader(new Uint32Array([
            version(false, 3, 0),
            predicatedMov,
            dst(RegType.TEMP, 0),
            src(RegType.TEMP, 1), // invalid predicate; p0 has RegType.PREDICATE
            src(RegType.INPUT, 0),
            END,
        ]))).toThrow(/predicate must be p0/);
    });

    test("rejects miscellaneous registers in vertex shaders", () => {
        expect(() => parseShader(new Uint32Array([
            version(false, 3, 0),
            (Op.MOV | (2 << 24)) >>> 0, dst(RegType.TEMP, 0), src(RegType.MISCTYPE, 0),
            END,
        ]))).toThrow(/invalid in a vertex shader/);
    });

    test("rejects pixel miscellaneous registers beyond vPos/vFace", () => {
        expect(() => parseShader(new Uint32Array([
            version(true, 3, 0),
            (Op.MOV | (2 << 24)) >>> 0, dst(RegType.TEMP, 0), src(RegType.MISCTYPE, 2),
            END,
        ]))).toThrow(/outside the vPos\/vFace range/);
    });

    test("rejects vertex generic output registers in pixel shaders", () => {
        expect(() => parseShader(new Uint32Array([
            version(true, 3, 0),
            (Op.MOV | (2 << 24)) >>> 0, dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
            END,
        ]))).toThrow(/generic output register/);
    });
});

// ── Heuristic WGSL sanity checks (catch the runtime-fatal classes) ────────────

/** No identifier may be declared both as `var X` and `let X` (the t0 collision). */
function assertNoVarLetCollision(wgsl: string): void {
    const vars = new Set<string>();
    const lets = new Set<string>();
    for (const m of wgsl.matchAll(/\bvar\s+([A-Za-z_]\w*)/g)) vars.add(m[1]);
    for (const m of wgsl.matchAll(/\blet\s+([A-Za-z_]\w*)/g)) lets.add(m[1]);
    for (const id of lets) {
        if (vars.has(id)) throw new Error(`identifier "${id}" declared as both var and let`);
    }
}

/** Every textureSample(texN, …) must have a matching `var texN:` declaration. */
function assertAllSampledTexturesDeclared(wgsl: string): void {
    const declared = new Set<string>();
    for (const m of wgsl.matchAll(/\bvar\s+(tex\d+)\s*:/g)) declared.add(m[1]);
    for (const m of wgsl.matchAll(/textureSample\(\s*(tex\d+)/g)) {
        if (!declared.has(m[1])) throw new Error(`sampled undeclared texture ${m[1]}`);
    }
}

describe("vs codegen", () => {
    const decl: RawVertexElement[] = [
        { stream: 0, offset: 0, type: 2 /*FLOAT3*/, usage: 0, usageIndex: 0 },
        { stream: 0, offset: 12, type: 1 /*FLOAT2*/, usage: 5, usageIndex: 0 },
    ];

    test("matrix op sizes the constant array to cover all rows", () => {
        const vsTokens = new Uint32Array([
            version(false, 1, 1),
            ...dcl(0, 0, 0),
            instr(Op.M4x4), dst(RegType.RASTOUT, 0), src(RegType.INPUT, 0), src(RegType.CONST, 0),
            END,
        ]);
        const vs = compileVertexShader(vsTokens);
        // m4x4 reads c0..c3 → constant array must be at least 4 wide.
        expect(vs.analysis.constantCount).toBeGreaterThanOrEqual(4);
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("vsc.c[3]");
    });

    test("relative addressing sizes constants to the register file", () => {
        const vsTokens = new Uint32Array([
            version(false, 1, 1),
            ...dcl(0, 0, 0),
            instr(Op.MOV), dst(RegType.ADDR, 0, 0x1), src(RegType.INPUT, 0),
            instr(Op.DP4), dst(RegType.RASTOUT, 0, 0x1), src(RegType.INPUT, 0),
                src(RegType.CONST, 0, SWZ_IDENTITY, 0, true /*relative*/),
            END,
        ]);
        const vs = compileVertexShader(vsTokens);
        expect(vs.prog.usesRelativeConst).toBe(true);
        // The whole register file (c0-c255), not the statically-referenced high-water mark:
        // a relative read is clamped to the last element, so a smaller array resolves a
        // matrix-palette index past its end to one fixed bone instead of failing.
        expect(vs.analysis.constantCount).toBe(256);
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("array<vec4<f32>, 258>");
        expect(res.wgsl).toContain("clamp(a0.x + 0, 0, 255)");
    });

    test("links a VS-only program to a complete WGSL module", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("@vertex");
        expect(res.wgsl).toContain("fn vs_main");
        expect(res.wgsl).toContain("@fragment");
        expect(res.wgsl).toContain("out.pos = vec4<f32>(oPos.x + oPos.w * vsc.c[5].x");
        // dp4 into oPos uses the constant array.
        expect(res.wgsl).toContain("vsc.c[0]");
        // def c4 baked.
        expect(res.wgsl).toContain("dc4");
        // input expansion: FLOAT3 position → vec4(in.v0, 1.0).
        expect(res.wgsl).toContain("vec4<f32>(in.v0, 1.0)");
        expect(res.wgsl).toContain(
            "out.col0 = min(max(oD0, vec4<f32>(0.0)), vec4<f32>(1.0));",
        );
        // The hidden c[] vec4 is internal; LinkResult keeps the guest-visible count.
        expect(res.vsConstantCount).toBe(5);
    });

    test("generated VS applies half-pixel dx/dy, preserves z/w, and marks position invariant", () => {
        const vs = compileVertexShader(buildVs());
        const link = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });

        expect(link.wgsl).toContain(
            "oPos.x + oPos.w * vsc.c[5].x, oPos.y + oPos.w * vsc.c[5].y, oPos.z, oPos.w",
        );
        expect(link.wgsl).toContain("@builtin(position) @invariant pos: vec4<f32>");
        expect(link.wgsl).not.toContain("640.0");
        expect(link.wgsl).not.toContain("480.0");

        expect(pixelCenterClipOffset(640, 480)).toEqual({ dx: 1 / 640, dy: -1 / 480 });
        (globalThis as Record<string, unknown>)[PIXEL_CENTRE_KILL_SWITCH] = true;
        expect(pixelCenterClipOffset(640, 480)).toEqual({ dx: 0, dy: 0 });
        // The kill-switch is runtime uniform state; generated source stays cacheable.
        const killSwitchLink = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(killSwitchLink.wgsl).toBe(link.wgsl);
    });

    test("uses the FFP texture-stage cascade for programmable VS + NULL PS", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({
            vs, ps: null, declElements: decl, streamStride: 20, ffpStageCount: 2,
            projectedStages: 1 << 1,
            samplerStates: new Map([[0, sampleSpec({ addressU: "d3d9-border", borderColor: 0x80402010 })]]),
        });
        // A hybrid draw declares both textures and their independently configured samplers;
        // stage 1 combines CURRENT with its own texel rather than falling back to white.
        expect(res.hasTexture).toBe(true);
        expect(res.wgsl).toContain("var<uniform> psc: PsUniforms");
        expect(res.wgsl).toContain("var samp: sampler");
        expect(res.wgsl).toContain("var samp1: sampler");
        expect(res.wgsl).toContain("textureSample(tex0, samp");
        expect(res.wgsl).toContain("textureSample(tex1, samp1");
        expect(res.wgsl).toContain("clamp((in.tex0.xy).x, 0.0, 1.0)");
        expect(res.wgsl).toContain("0.25098039215686274");
        expect(res.wgsl).toContain("psc.stages[0].a.x");
        expect(res.wgsl).toContain("psc.stages[1].a.x");
        expect(res.wgsl).toContain("psc.tfactor");
        // A programmable VS does not let D3DTSS_TEXCOORDINDEX remap its oT# outputs.
        // This synthetic shader writes no oT1, so stage 1 gets the defined zero fallback
        // rather than incorrectly reusing oT0.
        expect(res.wgsl).toContain("vec4<f32>(0.0, 0.0, 0.0, 1.0).xy / max(abs(vec4<f32>(0.0, 0.0, 0.0, 1.0).w)");
        expect(res.wgsl).toContain("psc.c[0].x > 2.5");
        expect(res.wgsl).toContain("psc.c[0].x > 1.5");
        expect(res.wgsl).toContain("psc.c[0].x > 0.5");
    });

    test("hybrid fragment ignores D3DTSS_TEXCOORDINDEX with a programmable VS", () => {
        // The vertex shader declares no pixel shader to consume t2, so the linker must retain
        // it specifically for the VS + fixed-function-pixel path.
        const base = buildVs();
        const vs = compileVertexShader(new Uint32Array([
            ...base.subarray(0, base.length - 1),
            instr(Op.MOV), dst(RegType.TEXCRDOUT, 2), src(RegType.INPUT, 1),
            END,
        ]));
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("@location(4) tex2: vec4<f32>");
        // Stage 0 consumes oT0 directly. oT2 must remain linked for stage 2, but a
        // captured TCI value may not redirect stage 0 to it.
        expect(res.wgsl).toContain("textureSample(tex0, samp, in.tex0.xy)");
        expect(res.wgsl).not.toContain("textureSample(tex0, samp, in.tex2.xy)");
    });

    test("builds vertex attributes from the declaration", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.vertexAttributes).toEqual([
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x2" },
        ]);
        expect(res.arrayStride).toBe(20);
    });

    test("links VS3/PS3 generic registers by declared semantics", () => {
        const i3 = (op: number, operands: number) => (op | (operands << 24)) >>> 0;
        const vs = compileVertexShader(new Uint32Array([
            version(false, 3, 0),
            ...dclReg(0 /* POSITION */, 0, RegType.INPUT, 0),
            ...dclReg(5 /* TEXCOORD */, 0, RegType.INPUT, 1),
            ...dclReg(0 /* POSITION */, 0, RegType.OUTPUT, 0),
            ...dclReg(5 /* TEXCOORD */, 2, RegType.OUTPUT, 3),
            i3(Op.MOV, 2), dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
            i3(Op.MOV, 2), dst(RegType.OUTPUT, 3), src(RegType.INPUT, 1),
            END,
        ]));
        const ps = compilePixelShader(new Uint32Array([
            version(true, 3, 0),
            ...dclReg(5 /* TEXCOORD */, 2, RegType.INPUT, 5),
            i3(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.INPUT, 5),
            END,
        ]));
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("oPos.x =");
        // Internal fields are compacted, but the VS TEXCOORD2 declaration and the
        // PS TEXCOORD2 declaration must resolve to that same compacted lane.
        expect(res.wgsl).toContain("oT0.x =");
        expect(res.wgsl).toContain("out.tex0 = oT0;");
        expect(res.wgsl).toContain("in.tex0");
        expect(res.wgsl).not.toContain("in.col5");
    });
});

describe("ps codegen", () => {
    const decl: RawVertexElement[] = [
        { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 },
        { stream: 0, offset: 12, type: 1, usage: 5, usageIndex: 0 },
    ];

    test("links VS+PS with a sampled texture", () => {
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(buildPs());
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(res.hasTexture).toBe(true);
        expect(res.wgsl).toContain("var tex0: texture_2d<f32>");
        expect(res.wgsl).toContain("textureSample(tex0, samp");
        expect(res.wgsl).toContain("return r0;");
        // The iterated texcoord t0 is seeded from the interpolant.
        expect(res.wgsl).toContain("var t0: vec4<f32> = in.tex0;");
    });

    test("declares a texture register the shader only writes", () => {
        // texreg2ar's destination stage is never read afterwards, but
        // writeRegName spells it `t1` regardless, so the variable must exist.
        const psTokens = new Uint32Array([
            version(true, 1, 3),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXREG2AR), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 0),
            END,
        ]);
        const res = linkProgram({
            vs: compileVertexShader(buildVs()), ps: compilePixelShader(psTokens),
            declElements: decl, streamStride: 20,
        });
        expect(res.wgsl).toContain("t1.x = ");
        expect(res.wgsl).toContain("var t1: vec4<f32>");
    });

    test("texbeml luminance scales all four sampled components", () => {
        // The SM1 reference is `t(m)RGBA *= t(n)B * LSCALE + LOFFSET`; Wine
        // applies it over the whole destination mask and DXVK over the whole
        // vector. Alpha is NOT exempt.
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXBEML), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 1),
            END,
        ]);
        const res = linkProgram({
            vs: compileVertexShader(buildVs()), ps: compilePixelShader(psTokens),
            declElements: decl, streamStride: 20,
        });
        expect(res.wgsl).toContain("psc.bump[1].lum.x + psc.bump[1].lum.y))");
        expect(res.wgsl).not.toMatch(/\.rgb \* \(\(t0\)\.z \* psc\.bump/);
    });

    test("packs b# constants and emits structured if/else flow", () => {
        const i2 = (op: number, operands: number) => (op | (operands << 24)) >>> 0;
        const psTokens = new Uint32Array([
            version(true, 2, 0),
            i2(Op.IF, 1), src(RegType.CONSTBOOL, 0),
            i2(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.CONST, 0),
            i2(Op.ELSE, 0),
            i2(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.CONST, 1),
            i2(Op.ENDIF, 0),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(ps.prog.maxBool).toBe(0);
        expect(res.psConstantCount).toBe(2);
        expect(res.wgsl).toContain("psBool(0u)");
        expect(res.wgsl).toContain("} else {");
    });

    test("tex into a texture register does not collide with a store temp", () => {
        // `tex t0` historically emitted `let t0 = …` clashing with `var t0`.
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(buildPs());
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        assertNoVarLetCollision(res.wgsl);
        expect(res.wgsl).toContain("_st"); // store temp uses the safe prefix
        expect(res.wgsl).not.toMatch(/\blet t0\b/);
    });

    test("exotic tex ops declare their sampled texture", () => {
        // texm3x3tex t2 samples stage 2 after consuming the three preceding rows —
        // texture binding must be declared.
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEXM3x3TEX), dst(RegType.TEXTURE, 2), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 2),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("var tex2: texture_2d<f32>");
        assertAllSampledTexturesDeclared(res.wgsl);
    });

    test("texbeml lowers the destination-stage bump matrix and luminance state", () => {
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXBEML), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 1),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(ps.analysis.usesLegacyBumpEnv).toBe(true);
        // [M00,M01,M10,M11] → u uses x/z and v uses y/w; TEXBEML scales the
        // fetched texel by src.b * LScale + LOffset (not by the sampled texel).
        expect(res.wgsl).toContain("struct LegacyBumpStage");
        expect(res.wgsl).toContain("psc.bump[1].mat.x");
        expect(res.wgsl).toContain("psc.bump[1].mat.z");
        expect(res.wgsl).toContain("psc.bump[1].mat.y");
        expect(res.wgsl).toContain("psc.bump[1].mat.w");
        expect(res.wgsl).toContain("_bemDuDv1 = (t0).xy * 2.0 - vec2<f32>(1.0)");
        expect(res.wgsl).toContain(".z * psc.bump[1].lum.x + psc.bump[1].lum.y");
        expect(res.wgsl).toContain("in.tex1");
        assertAllSampledTexturesDeclared(res.wgsl);
    });

    test("texbem projects before applying the bump offset", () => {
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXBEM), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 1),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({
            vs, ps, declElements: decl, streamStride: 20, projectedStages: 1 << 1,
        });
        expect(res.wgsl).toContain("let _bemBase1 = ((in.tex1) / ((in.tex1)).w);");
        expect(res.wgsl).toContain("_bemBase1.x + psc.bump[1].mat.x");
        expect(res.wgsl).not.toContain("(in.tex1).x + psc.bump[1].mat.x");
    });

    test("texm3x3pad to texm3x3vspec preserves matrix rows and per-stage eye ray", () => {
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXM3x3PAD), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.TEXM3x3PAD), dst(RegType.TEXTURE, 2), src(RegType.TEXTURE, 0),
            instr(Op.TEXM3x3VSPEC), dst(RegType.TEXTURE, 3), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 3),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20, cubeMask: 1 << 3 });
        // DXVK treats PAD as an instruction-stream marker; the final op re-reads all rows.
        expect(res.wgsl).toContain("// texm3x3pad (no-op)");
        expect(res.wgsl).not.toContain("_m3x3r0_t0 = dot");
        expect(res.wgsl).toContain("dot((in.tex1).xyz, (t0).xyz)");
        expect(res.wgsl).toContain("dot((in.tex2).xyz, (t0).xyz)");
        expect(res.wgsl).toContain("dot((in.tex3).xyz, (t0).xyz)");
        expect(res.wgsl).toContain("normalize((_m3Tc3).xyz)");
        expect(res.wgsl).toContain("normalize(vec3<f32>((in.tex1).w, (in.tex2).w, (in.tex3).w))");
        // WGSL reflect() is defined over the operands as given, so the normalize
        // calls above are what makes it the D3D result rather than the old
        // unnormalized `2 * dot(n,e) / dot(n,n) * n - e` approximation.
        expect(res.wgsl).toContain("-reflect(_m3Eye3, _m3Normal3)");
        expect(res.wgsl).not.toContain("2.0 * (dot(_m3");
        expect(res.wgsl).toContain("textureSample(tex3, samp3, (vec4<f32>(_m3Reflect3, 0.0)).xyz)");
        expect(res.wgsl).not.toContain("textureSample(tex1, samp1");
        expect(res.wgsl).not.toContain("textureSample(tex2, samp2");
        assertAllSampledTexturesDeclared(res.wgsl);
    });

    test("oracle legacy streams lower swizzles and matrix texture ops without approximations", () => {
        const tokensOf = (tokens: string[]) => new Uint32Array(tokens.map((token) => Number(token) >>> 0));
        const oracle = legacyTextureOracle.cases;
        const oracleCase = (name: string) => oracle.find((candidate) => candidate.name === name)!;
        const swizzles = compilePixelShader(tokensOf(oracleCase("ps_1_3_legacy_texreg2").tokens));
        const swizzleLink = linkProgram({
            vs: compileVertexShader(buildVs()), ps: swizzles,
            declElements: decl, streamStride: 20,
        });
        const swizzleWgsl = swizzleLink.wgsl;
        expect(swizzleWgsl).toContain("let _texreg21 = (t0).wxxx;");
        expect(swizzleWgsl).toContain("let _texreg22 = (t0).yzzz;");
        expect(swizzleWgsl).toContain("let _texreg23 = (t0).xyzz;");
        expect(swizzleLink.census.ps?.unsupportedOps).toEqual([]);

        const matrix = compilePixelShader(tokensOf(oracleCase("ps_1_3_legacy_texm3x2").tokens));
        const matrixLink = linkProgram({
            vs: compileVertexShader(buildVs()), ps: matrix,
            declElements: decl, streamStride: 20,
        });
        const matrixWgsl = matrixLink.wgsl;
        expect(matrixWgsl).toContain("// texm3x2pad (no-op)");
        expect(matrixWgsl).toContain("dot((in.tex1).xyz, (t0).xyz)");
        expect(matrixWgsl).toContain("dot((in.tex2).xyz, (t0).xyz)");
        expect(matrixLink.census.ps?.unsupportedOps).toEqual([]);

        const matrix3 = compilePixelShader(tokensOf(oracleCase("ps_1_3_legacy_texm3x3tex").tokens));
        const matrix3Link = linkProgram({
            vs: compileVertexShader(buildVs()), ps: matrix3,
            declElements: decl, streamStride: 20,
        });
        const matrix3Wgsl = matrix3Link.wgsl;
        expect(matrix3Wgsl).toContain("dot((in.tex1).xyz, (t0).xyz)");
        expect(matrix3Wgsl).toContain("dot((in.tex3).xyz, (t0).xyz)");
        expect(matrix3Link.census.ps?.unsupportedOps).toEqual([]);
    });

    test("texm3x3spec normalizes the explicit eye ray before reflect", () => {
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEX), dst(RegType.TEXTURE, 0),
            instr(Op.TEXM3x3SPEC), dst(RegType.TEXTURE, 3),
                src(RegType.TEXTURE, 0), src(RegType.TEXTURE, 1),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 3),
            END,
        ]);
        const res = linkProgram({
            vs: compileVertexShader(buildVs()), ps: compilePixelShader(psTokens),
            declElements: decl, streamStride: 20, cubeMask: 1 << 3,
        });
        expect(res.wgsl).toContain("let _m3Normal1 = normalize((_m3Tc1).xyz);");
        expect(res.wgsl).toContain("let _m3Eye1 = normalize((t1).xyz);");
        expect(res.wgsl).toContain("let _m3Reflect1 = -reflect(_m3Eye1, _m3Normal1);");
        expect(res.wgsl).not.toContain("2.0 * (dot(_m3");
    });

    test("texdepth uses the fragment-depth ABI rather than a color approximation", () => {
        const texdepth = compilePixelShader(new Uint32Array(
            legacyTextureOracle.cases.find((candidate) => candidate.name === "ps_1_4_texdepth")!.tokens
                .map((token) => Number(token) >>> 0),
        ));
        const res = linkProgram({
            vs: compileVertexShader(buildVs()), ps: texdepth,
            declElements: decl, streamStride: 20,
        });
        expect(res.wgsl).toContain("@builtin(frag_depth) depth: f32");
        expect(res.wgsl).toContain("oDepth = select(_legacyDepthZ");
        expect(res.census.ps?.unsupportedOps).toEqual([]);
        expect(res.wgsl).not.toContain("textureSample(tex5");
    });

    test("ps constants are clamped to [-1,1]", () => {
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.CONST, 0),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("clamp(psc.c[0], vec4<f32>(-1.0), vec4<f32>(1.0))");
    });
});

describe("alpha test", () => {
    const decl: RawVertexElement[] = [
        { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 },
        { stream: 0, offset: 12, type: 1, usage: 5, usageIndex: 0 },
    ];
    const linkWith = (alphaTest: { func: number; ref: number } | null) => {
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(buildPs());
        return linkProgram({ vs, ps, declElements: decl, streamStride: 20, alphaTest });
    };

    test("GREATEREQUAL discards on the ps output alpha with the 16-bit-replicated ref", () => {
        // func 7 = D3DCMP_GREATEREQUAL, ref 128 → refInt = (128<<8)|128 = 32896.
        const res = linkWith({ func: 7, ref: 128 });
        expect(res.wgsl).toContain("round((r0.a) * 65535.0)");
        expect(res.wgsl).toContain(">= 32896.0");
        expect(res.wgsl).toContain("discard");
    });

    test("ALWAYS (func 8) and no-alpha-test emit no discard", () => {
        expect(linkWith({ func: 8, ref: 200 }).wgsl).not.toContain("discard");
        expect(linkWith(null).wgsl).not.toContain("discard");
    });

    test("NEVER (func 1) discards unconditionally", () => {
        const res = linkWith({ func: 1, ref: 0 });
        expect(res.wgsl).toContain("discard");
        expect(res.wgsl).not.toContain("_atA");
    });

    test("LESS (func 2) maps to the < comparator", () => {
        const res = linkWith({ func: 2, ref: 255 });
        // ref 255 → (255<<8)|255 = 65535.
        expect(res.wgsl).toContain("< 65535.0");
    });

    test("alpha test also applies to the VS-only default fragment", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20, alphaTest: { func: 7, ref: 1 } });
        expect(res.wgsl).toContain("round((_c.a) * 65535.0)");
        expect(res.wgsl).toContain("discard");
    });
});
