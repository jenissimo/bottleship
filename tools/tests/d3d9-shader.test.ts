/**
 * D3D9 SM1.x → WGSL recompiler tests.
 *
 * Hand-assembles known vs_1_1 / ps_1_1 token streams (including the CTAB
 * comment block fxc emits after the version token — the original NFS Underground
 * `Unknown VS opcode 0xfffe` crash) and verifies parsing + WGSL codegen.
 */
import { describe, expect, test } from "bun:test";
import { parseShader } from "../../src/worker/backends/webgpu/d3d9/shader/sm-parser";
import {
    compileVertexShader, compilePixelShader, linkProgram, RawVertexElement,
} from "../../src/worker/backends/webgpu/d3d9/shader/index";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";

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
    return [instr(Op.DCL), (usage | (usageIndex << 16)) >>> 0, regBits(type, num)];
}
function def(num: number, x: number, y: number, z: number, w: number): number[] {
    const f = new Float32Array([x, y, z, w]);
    const u = new Uint32Array(f.buffer);
    return [instr(Op.DEF), regBits(RegType.CONST, num), u[0], u[1], u[2], u[3]];
}
const END = 0x0000FFFF;

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
        expect(res.wgsl).toContain("array<vec4<f32>, 256>");
        expect(res.wgsl).toContain("clamp(a0 + 0, 0, 255)");
    });

    test("links a VS-only program to a complete WGSL module", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({ vs, ps: null, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("@vertex");
        expect(res.wgsl).toContain("fn vs_main");
        expect(res.wgsl).toContain("@fragment");
        expect(res.wgsl).toContain("out.pos = oPos;");
        // dp4 into oPos uses the constant array.
        expect(res.wgsl).toContain("vsc.c[0]");
        // def c4 baked.
        expect(res.wgsl).toContain("dc4");
        // input expansion: FLOAT3 position → vec4(in.v0, 1.0).
        expect(res.wgsl).toContain("vec4<f32>(in.v0, 1.0)");
        expect(res.vsConstantCount).toBe(5);
    });

    test("uses the FFP texture-stage cascade for programmable VS + NULL PS", () => {
        const vs = compileVertexShader(buildVs());
        const res = linkProgram({
            vs, ps: null, declElements: decl, streamStride: 20, ffpStageCount: 2,
            projectedStages: 1 << 1,
        });
        // A hybrid draw declares both textures and their independently configured samplers;
        // stage 1 combines CURRENT with its own texel rather than falling back to white.
        expect(res.hasTexture).toBe(true);
        expect(res.wgsl).toContain("var<uniform> psc: PsUniforms");
        expect(res.wgsl).toContain("var ffpSamp0: sampler");
        expect(res.wgsl).toContain("var ffpSamp1: sampler");
        expect(res.wgsl).toContain("textureSample(tex0, ffpSamp0");
        expect(res.wgsl).toContain("textureSample(tex1, ffpSamp1");
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
        expect(res.wgsl).toContain("textureSample(tex0, ffpSamp0, in.tex0.xy)");
        expect(res.wgsl).not.toContain("textureSample(tex0, ffpSamp0, in.tex2.xy)");
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
        expect(res.wgsl).toContain("oT2.x =");
        expect(res.wgsl).toContain("out.tex2 = oT2;");
        expect(res.wgsl).toContain("in.tex2");
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
        expect(res.psConstantCount).toBe(225);
        expect(res.wgsl).toContain("if ((psc.c[224]).x != 0.0) {");
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
        // texm3x3tex t1 samples stage 1 — texture binding must be declared.
        const psTokens = new Uint32Array([
            version(true, 1, 1),
            instr(Op.TEXM3x3TEX), dst(RegType.TEXTURE, 1), src(RegType.TEXTURE, 0),
            instr(Op.MOV), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 1),
            END,
        ]);
        const vs = compileVertexShader(buildVs());
        const ps = compilePixelShader(psTokens);
        const res = linkProgram({ vs, ps, declElements: decl, streamStride: 20 });
        expect(res.wgsl).toContain("var tex1: texture_2d<f32>");
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
        // PAD stages are matrix rows, not texture samples; only the final stage is sampled.
        expect(res.wgsl).toContain("_m3x3r0_t0 = dot((in.tex1).xyz");
        expect(res.wgsl).toContain("_m3x3r1_t0 = dot((in.tex2).xyz");
        expect(res.wgsl).toContain("vec3<f32>((in.tex1).w, (in.tex2).w, (in.tex3).w)");
        expect(res.wgsl).toContain("2.0 * (dot(_m3N");
        expect(res.wgsl).toContain("textureSample(tex3, samp, _m3R");
        expect(res.wgsl).not.toContain("textureSample(tex1, samp");
        expect(res.wgsl).not.toContain("textureSample(tex2, samp");
        assertAllSampledTexturesDeclared(res.wgsl);
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
