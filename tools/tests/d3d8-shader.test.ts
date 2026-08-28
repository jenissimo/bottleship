/**
 * D3D8 VSD parser + decl-to-ffp tests.
 */
import { describe, expect, test } from "bun:test";
import { parseVsdDeclaration } from "../../src/worker/backends/webgpu/d3d8/vsd-parser";
import { declToSyntheticFvf } from "../../src/worker/backends/webgpu/d3d8/decl-to-ffp";
import { compileVertexShader, compilePixelShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader/index";
import { Op, RegType } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import {
    D3DVSD_STREAM,
    D3DVSD_REG,
    D3DVSD_SKIP,
    D3DVSD_END,
    D3DVSDE_POSITION,
    D3DVSDE_NORMAL,
    D3DVSDE_DIFFUSE,
    D3DVSDE_TEXCOORD0,
    D3DVSDT_FLOAT3,
    D3DVSDT_D3DCOLOR,
    D3DVSDT_FLOAT2,
    D3DVSD_TOKEN_STREAM,
    D3DVSD_TOKEN_STREAMDATA,
} from "../../src/worker/backends/webgpu/d3d8/vsd-constants";

/** Typical Morrowind-style XYZ + NORMAL + DIFFUSE + TEX0 decl (36-byte stride). */
const MORROWIND_STYLE_DECL = new Uint32Array([
    D3DVSD_STREAM(0),
    D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
    D3DVSD_REG(D3DVSDE_NORMAL, D3DVSDT_FLOAT3),
    D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
    D3DVSD_REG(D3DVSDE_TEXCOORD0, D3DVSDT_FLOAT2),
    D3DVSD_END,
]);

/** UE2/XIII-style two-stream decl: geometry in stream 0, extra UV set in stream 1. */
const TWO_STREAM_DECL = new Uint32Array([
    D3DVSD_STREAM(0),
    D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
    D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
    D3DVSD_REG(D3DVSDE_TEXCOORD0, D3DVSDT_FLOAT2),
    D3DVSD_STREAM(1),
    D3DVSD_REG(D3DVSDE_TEXCOORD0 + 1, D3DVSDT_FLOAT2),
    D3DVSD_END,
]);

describe("d3d8-vsd-macros", () => {
    test("match d3d8types.h encoding", () => {
        expect(D3DVSD_STREAM(0)).toBe(0x20000000);
        expect(D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3)).toBe(0x40020000);
        expect(D3DVSD_REG(D3DVSDE_NORMAL, D3DVSDT_FLOAT3)).toBe(0x40020003);
        expect(D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR)).toBe(0x40040005);
        expect(D3DVSD_REG(D3DVSDE_TEXCOORD0, D3DVSDT_FLOAT2)).toBe(0x40010007);
        expect(D3DVSD_SKIP(2)).toBe(0x50020000);
        expect((D3DVSD_STREAM(0) >>> 29) & 7).toBe(D3DVSD_TOKEN_STREAM);
        expect((D3DVSD_REG(0, D3DVSDT_FLOAT3) >>> 29) & 7).toBe(D3DVSD_TOKEN_STREAMDATA);
    });
});

describe("d3d8-vsd-parser", () => {
    test("parses Morrowind-style decl golden stream", () => {
        const parsed = parseVsdDeclaration(MORROWIND_STYLE_DECL);
        expect(parsed.elements.length).toBe(4);
        expect(parsed.stride).toBe(36);
        expect(parsed.streamStrides).toEqual([36]);
        expect(parsed.elements[0]).toMatchObject({ stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 });
        expect(parsed.elements[1]).toMatchObject({ offset: 12, type: 2, usage: 3 });
        expect(parsed.elements[2]).toMatchObject({ offset: 24, type: 4, usage: 10, usageIndex: 0 });
        expect(parsed.elements[3]).toMatchObject({ offset: 28, type: 1, usage: 5, usageIndex: 0 });
    });

    test("handles SKIP tokens", () => {
        const decl = new Uint32Array([
            D3DVSD_STREAM(0),
            D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
            D3DVSD_SKIP(9),
            D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
            D3DVSD_END,
        ]);
        const parsed = parseVsdDeclaration(decl);
        expect(parsed.elements[1].offset).toBe(48); // 12 + 36 skip
    });

    test("parses multi-stream decl with per-stream offsets and strides", () => {
        const parsed = parseVsdDeclaration(TWO_STREAM_DECL);
        expect(parsed.elements.length).toBe(4);
        expect(parsed.streamStrides).toEqual([24, 8]);
        expect(parsed.stride).toBe(24); // stream-0 stride
        // Stream-1 element restarts at offset 0 and keeps its register (v8 = TEXCOORD1).
        expect(parsed.elements[3]).toMatchObject({
            stream: 1, offset: 0, type: 1, usage: 5, usageIndex: 1, reg: D3DVSDE_TEXCOORD0 + 1,
        });
    });

    test("elements carry their D3DVSD register (v#)", () => {
        const parsed = parseVsdDeclaration(MORROWIND_STYLE_DECL);
        expect(parsed.elements.map(e => e.reg)).toEqual([
            D3DVSDE_POSITION, D3DVSDE_NORMAL, D3DVSDE_DIFFUSE, D3DVSDE_TEXCOORD0,
        ]);
    });
});

describe("d3d8-decl-to-ffp", () => {
    test("synthesizes FVF from parsed decl", () => {
        const parsed = parseVsdDeclaration(MORROWIND_STYLE_DECL);
        const mapped = declToSyntheticFvf(parsed.elements, parsed.stride);
        expect(mapped.stride).toBe(36);
        expect(mapped.faithful).toBe(true);
        expect(mapped.interleave).toBeUndefined();
        expect(mapped.fvf & 0x002).toBeTruthy(); // XYZ
        expect(mapped.fvf & 0x010).toBeTruthy(); // NORMAL
        expect(mapped.fvf & 0x040).toBeTruthy(); // DIFFUSE
        expect(mapped.fvf & 0x100).toBeTruthy(); // TEX1
    });

    test("multi-stream decl produces canonical interleave plan", () => {
        const parsed = parseVsdDeclaration(TWO_STREAM_DECL);
        const mapped = declToSyntheticFvf(parsed.elements, parsed.stride);
        expect(mapped.faithful).toBe(true);
        expect(mapped.fvf).toBe(0x242); // XYZ | DIFFUSE | TEX2
        expect(mapped.stride).toBe(32); // 12 pos + 4 diffuse + 8 tex0 + 8 tex1
        // slotSize is the canonical slot width: equal to `size` for every element here, and
        // the interleaver zeroes [size, slotSize) so a degraded element cannot inherit the
        // previous draw's bytes out of the reused scratch.
        expect(mapped.interleave).toEqual([
            { stream: 0, srcOffset: 0, dstOffset: 0, size: 12, slotSize: 12, swizzleColorBytes: undefined },
            { stream: 0, srcOffset: 12, dstOffset: 12, size: 4, slotSize: 4, swizzleColorBytes: undefined },
            { stream: 0, srcOffset: 16, dstOffset: 16, size: 8, slotSize: 8, swizzleColorBytes: undefined },
            { stream: 1, srcOffset: 0, dstOffset: 24, size: 8, slotSize: 8, swizzleColorBytes: undefined },
        ]);
    });
});

describe("d3d8-shader-compile", () => {
    const reg = (t: number, n: number) => (((t & 7) << 28) | (((t >>> 3) & 3) << 11) | (n & 0x7ff)) >>> 0;
    const ver = (ps: boolean, maj: number, min: number) => (((ps ? 0xffff : 0xfffe) << 16) | (maj << 8) | min) >>> 0;
    const ins = (op: number) => op >>> 0;
    const dst = (t: number, n: number, mask = 0xf) => (reg(t, n) | (mask << 16)) >>> 0;
    const src = (t: number, n: number) => reg(t, n);

    test("linkProgram accepts VSD-derived decl with SM1 bytecode", () => {
        const vsTokens = new Uint32Array([
            ver(false, 1, 1),
            0x0004fffe, 0x42415443, 0, 1, 2,
            ins(Op.DCL), 0, reg(RegType.INPUT, 0),
            ins(Op.DCL), 5, reg(RegType.INPUT, 1),
            ins(Op.DEF), reg(RegType.CONST, 4), 0x3f800000, 0x3f800000, 0x3f800000, 0x3f800000,
            ins(Op.DP4), dst(RegType.RASTOUT, 0, 1), src(RegType.INPUT, 0), src(RegType.CONST, 0),
            ins(Op.MOV), dst(RegType.TEXCRDOUT, 0), src(RegType.INPUT, 1),
            0xffff,
        ]);
        const psTokens = new Uint32Array([
            ver(true, 1, 1),
            0x0001fffe, 0xcafe,
            ins(Op.TEX), dst(RegType.TEXTURE, 0),
            ins(Op.MUL), dst(RegType.TEMP, 0), src(RegType.TEXTURE, 0), src(RegType.INPUT, 0),
            0xffff,
        ]);
        const parsed = parseVsdDeclaration(MORROWIND_STYLE_DECL);
        const vs = compileVertexShader(vsTokens);
        const ps = compilePixelShader(psTokens);
        const link = linkProgram({ vs, ps, declElements: parsed.elements, streamStride: parsed.stride });
        expect(link.wgsl).toContain("fn vs_main");
        expect(link.wgsl).toContain("fn fs_main");
        // Legacy single-stream link: vertexBuffers mirrors the legacy layout fields.
        expect(link.vertexBuffers.length).toBe(1);
        expect(link.vertexBuffers[0]).toEqual({ arrayStride: link.arrayStride, attributes: link.vertexAttributes });
    });

    test("no-dcl D3D8 bytecode maps inputs by VSD register with per-stream buffers", () => {
        // Faithful vs_1_1 as D3D8 shipped it: NO dcl instructions — input registers are
        // bound by the D3DVSD declaration itself (v0=position, v5=diffuse, v7/v8=UVs).
        const vsTokens = new Uint32Array([
            ver(false, 1, 1),
            ins(Op.DP4), dst(RegType.RASTOUT, 0, 1), src(RegType.INPUT, 0), src(RegType.CONST, 0),
            ins(Op.MOV), dst(RegType.ATTROUT, 0), src(RegType.INPUT, 5),
            ins(Op.MOV), dst(RegType.TEXCRDOUT, 0), src(RegType.INPUT, 7),
            ins(Op.MOV), dst(RegType.TEXCRDOUT, 1), src(RegType.INPUT, 8),
            0xffff,
        ]);
        const parsed = parseVsdDeclaration(TWO_STREAM_DECL);
        const vs = compileVertexShader(vsTokens);
        expect(vs.analysis.inputDcls.length).toBe(0);
        const link = linkProgram({
            vs, ps: null,
            declElements: parsed.elements,
            streamStride: parsed.streamStrides[0],
            streamStrides: parsed.streamStrides,
        });
        expect(link.vertexBuffers.length).toBe(2);
        const b0 = link.vertexBuffers[0]!;
        const b1 = link.vertexBuffers[1]!;
        expect(b0.arrayStride).toBe(24);
        expect(b1.arrayStride).toBe(8);
        expect([...b0.attributes].map(a => a.shaderLocation)).toEqual([0, 5, 7]);
        expect([...b1.attributes].map(a => a.shaderLocation)).toEqual([8]);
        expect([...b1.attributes][0].offset).toBe(0);
        expect(link.wgsl).toContain("@location(8) v8: vec2<f32>");
    });

    test("multi-stream link falls back to decl stride when SetStreamSource stride is 0", () => {
        const vsTokens = new Uint32Array([
            ver(false, 1, 1),
            ins(Op.DP4), dst(RegType.RASTOUT, 0, 1), src(RegType.INPUT, 0), src(RegType.CONST, 0),
            0xffff,
        ]);
        const parsed = parseVsdDeclaration(TWO_STREAM_DECL);
        const vs = compileVertexShader(vsTokens);
        const link = linkProgram({
            vs, ps: null,
            declElements: parsed.elements,
            streamStride: null,
            streamStrides: [null, null],
        });
        expect(link.vertexBuffers[0]!.arrayStride).toBe(24);
        expect(link.vertexBuffers[1]!.arrayStride).toBe(8);
    });

    test("accepts vs_1_0 bytecode version token", () => {
        const vs10 = new Uint32Array([
            ver(false, 1, 0),
            0x0004fffe, 0x42415443, 0, 1, 2,
            ins(Op.DCL), 0, reg(RegType.INPUT, 0),
            ins(Op.DEF), reg(RegType.CONST, 0), 0x3f800000, 0, 0, 0x3f800000,
            ins(Op.DP4), dst(RegType.RASTOUT, 0, 1), src(RegType.INPUT, 0), src(RegType.CONST, 0),
            0xffff,
        ]);
        const vs = compileVertexShader(vs10);
        expect(vs.prog.major).toBe(1);
        expect(vs.prog.minor).toBe(0);
    });
});
