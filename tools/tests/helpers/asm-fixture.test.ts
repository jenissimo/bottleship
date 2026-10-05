import { describe, expect, test } from "bun:test";
import { asmFixture, d3dxOracleAvailable } from "./asm-fixture";
import { compileVertexShader, linkProgram } from "../../../src/worker/backends/webgpu/d3d9/shader";

describe.skipIf(!d3dxOracleAvailable())("asm-fixture", () => {
    test("uses d3dx-oracle tokens as parser input for the loop fixture", async () => {
        const source = `
            vs_2_0
            dcl_position v0
            dcl_texcoord v1
            defi i0, 1, 0, 0, 0
            loop aL, i0
            add r0, r0, c0
            endloop
            mov oPos, v0
            mov oT0, v1
        `;
        const fixture = await asmFixture(source);
        expect(fixture.tokens).toBeInstanceOf(Uint32Array);
        const program = fixture;
        const { assemble } = await import("../../d3dx-oracle");
        const oracle = assemble(source);
        if (!oracle.tokens) throw new Error(oracle.error ?? "oracle returned no tokens");
        expect([...fixture.tokens]).toEqual([...oracle.tokens]);
        expect(`${program.isPixelShader ? "ps" : "vs"}_${program.major}_${program.minor}`).toBe("vs_2_0");
        expect(program.instructions.map((instruction) => instruction.opcode)).toHaveLength(5);

        const linked = linkProgram({
            vs: compileVertexShader(fixture.tokens),
            ps: null,
            declElements: null,
            streamStride: 16,
        });
        expect(linked.wgsl).toContain("for (var _loopI");
        expect(linked.wgsl).toContain("var aL: i32");
        expect(linked.census.vs.unsupportedOps).toEqual([]);
    });
});
