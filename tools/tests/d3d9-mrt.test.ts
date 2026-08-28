/** Focused W11 acceptance: declared PS MRT outputs are distinct WGSL locations. */
import { describe, expect, test } from "bun:test";
import { compilePixelShader, compileVertexShader, linkProgram } from "../../src/worker/backends/webgpu/d3d9/shader";
import { Op, RegType, Usage } from "../../src/worker/backends/webgpu/d3d9/shader/sm-enums";
import {
    buildColorTargetState,
    computeBlendKey,
    D3DRS_ALPHABLENDENABLE,
    D3DRS_COLORWRITEENABLE,
    D3DRS_COLORWRITEENABLE1,
    D3DRS_COLORWRITEENABLE2,
    D3DRS_COLORWRITEENABLE3,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { writeDeviceCaps9 } from "../../src/worker/modules/d3d9/caps";

const SWZ_IDENTITY = 0xE4;
const END = 0x0000FFFF;

function regBits(type: number, num: number): number {
    return (((type & 7) << 28) | (((type >>> 3) & 3) << 11) | (num & 0x7FF)) >>> 0;
}
function version(isPs: boolean, major: number, minor: number): number {
    return (((isPs ? 0xFFFF : 0xFFFE) << 16) | (major << 8) | minor) >>> 0;
}
function instr(op: number, operands = 0): number { return (op | (operands << 24)) >>> 0; }
function dst(type: number, num: number): number { return (regBits(type, num) | (0xF << 16)) >>> 0; }
function src(type: number, num: number): number { return (regBits(type, num) | (SWZ_IDENTITY << 16)) >>> 0; }
function dclReg(usage: number, usageIndex: number, type: number, num: number): number[] {
    return [instr(Op.DCL, 2), (usage | (usageIndex << 16)) >>> 0, regBits(type, num)];
}

const positionDecl = [{ stream: 0, offset: 0, type: 2, usage: Usage.POSITION, usageIndex: 0 }];
const vsTokens = new Uint32Array([
    version(false, 3, 0),
    ...dclReg(Usage.POSITION, 0, RegType.INPUT, 0),
    ...dclReg(Usage.POSITION, 0, RegType.OUTPUT, 0),
    instr(Op.MOV, 2), dst(RegType.OUTPUT, 0), src(RegType.INPUT, 0),
    END,
]);

function linkPixel(instructions: number[]): string {
    return linkProgram({
        vs: compileVertexShader(vsTokens),
        ps: compilePixelShader(new Uint32Array([version(true, 3, 0), ...instructions, END])),
        declElements: positionDecl,
        streamStride: 12,
    }).wgsl;
}

describe("D3D9 SM3 MRT (W11)", () => {
    test("oC0 and oC1 are distinct fragment outputs", () => {
        const wgsl = linkPixel([
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.CONST, 0),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 1), src(RegType.CONST, 1),
        ]);

        expect(wgsl).toContain("@location(0) color: vec4<f32>");
        expect(wgsl).toContain("@location(1) color1: vec4<f32>");
        expect(wgsl).toContain("out.color = oC0;");
        expect(wgsl).toContain("out.color1 = oC1;");
        expect(wgsl).toContain("oC0.x =");
        expect(wgsl).toContain("oC1.x =");
    });

    test("an undeclared oC1 is not emitted as a WGSL symbol", () => {
        const wgsl = linkPixel([
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.CONST, 0),
        ]);

        expect(wgsl).toContain("@location(0) vec4<f32>");
        expect(wgsl).not.toContain("oC1");
        expect(wgsl).not.toContain("color1");
    });

    test("oC3 keeps its location while oC2 remains an inactive attachment slot", () => {
        const wgsl = linkPixel([
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 0), src(RegType.CONST, 0),
            instr(Op.MOV, 2), dst(RegType.COLOROUT, 3), src(RegType.CONST, 3),
        ]);

        expect(wgsl).toContain("@location(3) color3: vec4<f32>");
        expect(wgsl).toContain("out.color3 = oC3;");
        expect(wgsl).not.toContain("@location(2) color2");
    });
});

describe("D3D9 MRT independent write masks", () => {
    const masks = [0x1, 0x2, 0x4, 0x8];
    const states = [
        D3DRS_COLORWRITEENABLE,
        D3DRS_COLORWRITEENABLE1,
        D3DRS_COLORWRITEENABLE2,
        D3DRS_COLORWRITEENABLE3,
    ];
    const renderState = (overrides: Record<number, number> = {}) => (state: number): number => {
        const maskIndex = states.indexOf(state);
        if (maskIndex >= 0) return overrides[state] ?? masks[maskIndex];
        if (state === D3DRS_ALPHABLENDENABLE) return 0;
        return overrides[state] ?? 0;
    };

    test("each color target selects COLORWRITEENABLE0..3", () => {
        const getRS = renderState();
        for (let targetIndex = 0; targetIndex < 4; targetIndex++) {
            expect(buildColorTargetState("bgra8unorm", getRS, targetIndex).writeMask).toBe(masks[targetIndex]);
        }
    });

    test("the blend cache key includes every target mask", () => {
        const baseline = computeBlendKey(renderState());
        for (const state of states) {
            expect(computeBlendKey(renderState({ [state]: 0xf }))).not.toBe(baseline);
        }
    });

    test("rejects target indices outside the D3D9 MRT range", () => {
        expect(() => buildColorTargetState("bgra8unorm", renderState(), 4)).toThrow(RangeError);
    });
});

describe("D3D9 MRT capability contract", () => {
    test("advertises implemented write-mask/blend caps but not independent bit depths", () => {
        const memory = new Uint8Array(0x1000);
        const capsPtr = 0x100;
        Mem.bind(() => memory);
        expect(writeDeviceCaps9(capsPtr)).toBe(true);
        const caps = new DataView(memory.buffer, capsPtr, 304);
        const primitiveMiscCaps = caps.getUint32(32, true);

        expect(primitiveMiscCaps & 0x00004000).toBe(0x00004000); // INDEPENDENTWRITEMASKS
        expect(primitiveMiscCaps & 0x00080000).toBe(0x00080000); // MRTPOSTPIXELSHADERBLENDING
        expect(primitiveMiscCaps & 0x00040000).toBe(0);          // MRTINDEPENDENTBITDEPTHS
        expect(caps.getUint32(240, true)).toBe(4);               // NumSimultaneousRTs
    });
});
