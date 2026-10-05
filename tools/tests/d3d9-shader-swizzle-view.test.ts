/**
 * The D3D9 → WGSL emitter must never write a single component through a mutable vector var
 * (`r0.x = …`, `a0.y = …`). That is legal WGSL — naga accepts it — but Chromium's Dawn/Tint
 * currently fails to lower the resulting writable swizzle view ("swizzle view instruction
 * still has usages after lowering"), which invalidates the pipeline and sends every later
 * draw to drawIndexed:noPipeline. Reads of a mutable var are indexed for the same reason.
 *
 * The instance-storage VS variant declares the float bank only, so a program that reads the
 * integer or boolean constant file must be refused at LINK time, before the emitter can name
 * a bank the module never declared.
 */
import { describe, expect, test } from "bun:test";
import {
    compileVertexShader, linkProgram, isLinkRefused, type CompiledVs,
} from "../../src/worker/backends/webgpu/d3d9/shader/link";
import { asmFixture, d3dxOracleAvailable } from "./helpers/asm-fixture";

const POSITION_DECL = [{ stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 }];

/** Any `name.<component> =` assignment — the construct Tint fails to lower. */
const COMPONENT_ASSIGNMENT = /\b[A-Za-z_]\w*\.[xyzwrgba]\s*=(?!=)/;

async function compiledVs(source: string): Promise<CompiledVs> {
    return compileVertexShader((await asmFixture(source)).tokens);
}

describe.skipIf(!d3dxOracleAvailable())("D3D9 emitter avoids Tint swizzle views", () => {
    test("mova rebuilds the whole a0 vector instead of assigning a component", async () => {
        const vs = await compiledVs(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            mova a0.x, v0.x
            mov r0, c[a0.x + 0]
            mov o0, r0
        `);
        const { wgsl } = linkProgram({ vs, ps: null, declElements: POSITION_DECL, streamStride: 12 });

        expect(wgsl).toContain("var a0: vec4<i32>");
        expect(wgsl).toContain("a0 = vec4<i32>(");
        // The unwritten lanes must read the old a0 back, not zero.
        expect(wgsl).toContain("a0[1], a0[2], a0[3])");
        expect(wgsl).not.toMatch(/a0\.[xyzw]\s*=/);
        expect(wgsl).not.toMatch(COMPONENT_ASSIGNMENT);
    });

    test("a masked mova preserves the other lanes and never swizzle-reads a0", async () => {
        const vs = await compiledVs(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            mova a0.y, v0.x
            mov r0, c[a0.y + 1]
            mov o0, r0
        `);
        const { wgsl } = linkProgram({ vs, ps: null, declElements: POSITION_DECL, streamStride: 12 });

        expect(wgsl).toContain("a0 = vec4<i32>(a0[0], i32(");
        expect(wgsl).not.toMatch(/a0\.[xyzw]/);
    });

    test("a whole shader body carries no component assignment on any register", async () => {
        const vs = await compiledVs(`
            vs_3_0
            dcl_position v0
            dcl_texcoord0 v1
            dcl_position o0
            dcl_texcoord0 o1
            dcl_color0 o2
            def c8, 0.5, 1.0, 2.0, 0.0
            mova a0.x, v0.w
            dp4 r0.x, v0, c[a0.x + 0]
            dp4 r0.y, v0, c1
            mad r1.xz, r0.yzxw, c8.wwww, r0
            mov o0, r0
            mov o1.xy, v1.yxzw
            mov o2, r1.zyxw
        `);
        const { wgsl } = linkProgram({ vs, ps: null, declElements: POSITION_DECL, streamStride: 12 });

        expect(wgsl).not.toMatch(COMPONENT_ASSIGNMENT);
    });
});

describe.skipIf(!d3dxOracleAvailable())("instance-storage VS link eligibility", () => {
    test("a float-only vertex shader links against the storage bank", async () => {
        const vs = await compiledVs(`
            vs_3_0
            dcl_position v0
            dcl_position o0
            dp4 r0.x, v0, c0
            mov o0, r0
        `);
        const link = linkProgram({
            vs, ps: null, declElements: POSITION_DECL, streamStride: 12,
            vsConstantMode: "instance-storage",
        });

        expect(link.refused).toBeNull();
        expect(isLinkRefused(link)).toBe(false);
        expect(link.wgsl).toContain("var<storage, read> vscSlots");
        expect(link.wgsl).toContain("vscSlots[_bsInstance]");
        expect(link.vsStorageSlotBytes).toBeGreaterThan(0);
        // The storage bank has neither of these; nothing may reference them.
        expect(link.wgsl).not.toContain("vsBool(");
        expect(link.wgsl).not.toMatch(/vscSlots\[_bsInstance\]\.i\[/);
    });

    for (const [name, source] of [
        ["a boolean constant read", `
            vs_3_0
            dcl_position v0
            dcl_position o0
            defb b0, true
            if b0
                mov r0, c0
            endif
            mov o0, r0
        `],
        ["an integer constant loop", `
            vs_3_0
            dcl_position v0
            dcl_position o0
            defi i0, 4, 0, 1, 0
            mov r0, c0
            loop aL, i0
                add r0, r0, c[aL + 1]
            endloop
            mov o0, r0
        `],
    ] as const) {
        test(`${name} is refused in storage mode, with the reason`, async () => {
            const vs = await compiledVs(source);
            const link = linkProgram({
                vs, ps: null, declElements: POSITION_DECL, streamStride: 12,
                vsConstantMode: "instance-storage",
            });

            expect(isLinkRefused(link)).toBe(true);
            expect(link.refused?.reason).toBe("vs-integer-boolean-in-instance-storage");
            expect(link.vsStorageSlotBytes).toBe(0);
            expect(link.wgsl).not.toContain("vscSlots");

            // The same program links normally against the uniform bank, which declares both.
            const uniform = linkProgram({ vs, ps: null, declElements: POSITION_DECL, streamStride: 12 });
            expect(uniform.refused).toBeNull();
            expect(uniform.wgsl).toContain("fn vsBool(n: u32)");
        });
    }
});
