import { describe, expect, test } from "bun:test";
import {
    buildColorTargetState, buildDepthStencilState, computeBlendKey,
    D3DRS_SRCBLEND, D3DRS_DESTBLEND, D3DRS_ALPHABLENDENABLE, D3DRS_BLENDOP, D3DRS_BLENDFACTOR,
    D3DRS_COLORWRITEENABLE, D3DRS_SEPARATEALPHABLENDENABLE,
    D3DRS_SRCBLENDALPHA, D3DRS_DESTBLENDALPHA, D3DRS_BLENDOPALPHA, hasUnsupportedBlendFactor,
    isD3D9BlendStateRepresentable,
    D3DRS_STENCILENABLE, D3DRS_TWOSIDEDSTENCILMODE, hasUnsupportedStencilState,
    D3DRS_CULLMODE, D3DRS_ZENABLE, D3DRS_ZWRITEENABLE, D3DRS_ZFUNC, D3DRS_STENCILFUNC,
    D3DRS_STENCILFAIL, D3DRS_STENCILZFAIL, D3DRS_STENCILPASS, D3DRS_STENCILMASK, D3DRS_STENCILWRITEMASK,
    D3DRS_CCW_STENCILFUNC, D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL,
    D3DRS_CCW_STENCILPASS, isD3D9DepthStencilStateRepresentable, d3dColorToGpu,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// D3D9 default render states the state tracker seeds (see d3d9-state-tracker
// seedRenderStateDefaults). The blend helpers read raw render states, so tests
// start from these defaults and override per case.
function defaults(): Record<number, number> {
    return {
        [D3DRS_SRCBLEND]: 2,        // D3DBLEND_ONE
        [D3DRS_DESTBLEND]: 1,       // D3DBLEND_ZERO
        [D3DRS_BLENDOP]: 1,         // D3DBLENDOP_ADD
        [D3DRS_SRCBLENDALPHA]: 2,   // D3DBLEND_ONE
        [D3DRS_DESTBLENDALPHA]: 1,  // D3DBLEND_ZERO
        [D3DRS_BLENDOPALPHA]: 1,    // D3DBLENDOP_ADD
        [D3DRS_COLORWRITEENABLE]: 0xf,
        [D3DRS_ALPHABLENDENABLE]: 0,
        [D3DRS_SEPARATEALPHABLENDENABLE]: 0,
    };
}
const get = (m: Record<number, number>) => (state: number) => m[state] ?? 0;
const FMT: GPUTextureFormat = "bgra8unorm";

describe("buildColorTargetState — blend disabled (default)", () => {
    test("no blend object, full write mask", () => {
        const t = buildColorTargetState(FMT, get(defaults()));
        expect(t.blend).toBeUndefined();
        expect(t.writeMask).toBe(0xf);
        expect(t.format).toBe(FMT);
    });

    test("COLORWRITEENABLE=0 disables all channel writes (z/stencil-only pass)", () => {
        const m = defaults(); m[D3DRS_COLORWRITEENABLE] = 0;
        expect(buildColorTargetState(FMT, get(m)).writeMask).toBe(0);
    });
});

describe("buildColorTargetState — standard alpha blend", () => {
    test("SRCALPHA / INVSRCALPHA + ADD (the classic transparency setup)", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 5;   // D3DBLEND_SRCALPHA
        m[D3DRS_DESTBLEND] = 6;  // D3DBLEND_INVSRCALPHA
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
        // Without separate-alpha, the alpha op mirrors the colour op.
        expect(blend.alpha).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
    });

    test("additive (ONE / ONE)", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 2; m[D3DRS_DESTBLEND] = 2; // ONE / ONE
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("one");
        expect(blend.color.dstFactor).toBe("one");
    });

    test("REVSUBTRACT blend op maps", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_BLENDOP] = 3; // REVSUBTRACT
        expect(buildColorTargetState(FMT, get(m)).blend!.color.operation).toBe("reverse-subtract");
    });
});

describe("buildColorTargetState — DirectX-6 BOTH*SRCALPHA fixup", () => {
    test("BOTHSRCALPHA as src forces dst = INVSRCALPHA", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 12; // D3DBLEND_BOTHSRCALPHA
        m[D3DRS_DESTBLEND] = 2; // ignored — overridden by fixup
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("src-alpha");
        expect(blend.color.dstFactor).toBe("one-minus-src-alpha");
    });

    test("BOTHINVSRCALPHA as src forces the inverse pair", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_SRCBLEND] = 13; // BOTHINVSRCALPHA
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color.srcFactor).toBe("one-minus-src-alpha");
        expect(blend.color.dstFactor).toBe("src-alpha");
    });
});

describe("buildColorTargetState — separate alpha blend", () => {
    test("alpha channel uses its own factors/op", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 5; m[D3DRS_DESTBLEND] = 6;       // colour: SRCALPHA/INVSRCALPHA
        m[D3DRS_SEPARATEALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLENDALPHA] = 2; m[D3DRS_DESTBLENDALPHA] = 1; // alpha: ONE/ZERO
        m[D3DRS_BLENDOPALPHA] = 5;                             // alpha: MAX
        const blend = buildColorTargetState(FMT, get(m)).blend!;
        expect(blend.color).toEqual({ srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" });
        expect(blend.alpha).toEqual({ srcFactor: "one", dstFactor: "zero", operation: "max" });
    });
});

describe("buildColorTargetState — dual-source and constant factors", () => {
    test("refuses SRCCOLOR2 instead of silently using the first source", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 16; // D3DBLEND_SRCCOLOR2
        expect(() => buildColorTargetState(FMT, get(m))).toThrow(/dual-source/);
    });

    test("lowers BLENDFACTOR to WebGPU's dynamic blend constant", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 14; // D3DBLEND_BLENDFACTOR
        m[D3DRS_BLENDFACTOR] = 0x80402010;
        expect(hasUnsupportedBlendFactor(m[D3DRS_SRCBLEND]!)).toBe(false);
        expect(buildColorTargetState(FMT, get(m)).blend!.color.srcFactor).toBe("constant");
    });
});

describe("blend state validation", () => {
    test("refuses an unknown factor instead of mapping it to ONE", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 0xdead;
        expect(isD3D9BlendStateRepresentable(get(m))).toBe(false);
        expect(() => buildColorTargetState(FMT, get(m))).toThrow(/invalid factor or operation/);
    });

    test("refuses an unknown blend operation instead of mapping it to ADD", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_BLENDOP] = 0xdead;
        expect(isD3D9BlendStateRepresentable(get(m))).toBe(false);
        expect(() => buildColorTargetState(FMT, get(m))).toThrow(/invalid factor or operation/);
    });

    test("does not consume malformed blend fields while blending is disabled", () => {
        const m = defaults();
        m[D3DRS_SRCBLEND] = 0xdead;
        m[D3DRS_BLENDOP] = 0xdead;
        expect(isD3D9BlendStateRepresentable(get(m))).toBe(true);
        expect(buildColorTargetState(FMT, get(m)).blend).toBeUndefined();
    });
});

describe("computeBlendKey", () => {
    test("disabled state keys differ only by write mask", () => {
        const m = defaults();
        const k1 = computeBlendKey(get(m));
        m[D3DRS_COLORWRITEENABLE] = 0x7;
        expect(computeBlendKey(get(m))).not.toBe(k1);
    });

    test("enabling blend changes the key (forces a fresh pipeline)", () => {
        const m = defaults();
        const off = computeBlendKey(get(m));
        m[D3DRS_ALPHABLENDENABLE] = 1; m[D3DRS_SRCBLEND] = 5; m[D3DRS_DESTBLEND] = 6;
        expect(computeBlendKey(get(m))).not.toBe(off);
    });

    test("identical blend state yields identical keys (cache hit)", () => {
        const a = defaults(); a[D3DRS_ALPHABLENDENABLE] = 1; a[D3DRS_SRCBLEND] = 5; a[D3DRS_DESTBLEND] = 6;
        const b = defaults(); b[D3DRS_ALPHABLENDENABLE] = 1; b[D3DRS_SRCBLEND] = 5; b[D3DRS_DESTBLEND] = 6;
        expect(computeBlendKey(get(a))).toBe(computeBlendKey(get(b)));
    });

    test("blend constant is dynamic state and does not participate in the pipeline key", () => {
        const m = defaults();
        m[D3DRS_ALPHABLENDENABLE] = 1;
        m[D3DRS_SRCBLEND] = 14;
        const first = computeBlendKey(get(m));
        m[D3DRS_BLENDFACTOR] = 0x80402010;
        expect(computeBlendKey(get(m))).toBe(first);
    });
});

describe("buildDepthStencilState — single-sided stencil", () => {
    test("applies the front stencil operations to back faces when two-sided mode is disabled", () => {
        const m = {
            [D3DRS_CULLMODE]: 3,
            [D3DRS_ZENABLE]: 1,
            [D3DRS_ZFUNC]: 4,
            [D3DRS_ZWRITEENABLE]: 1,
            [D3DRS_STENCILENABLE]: 1,
            [D3DRS_TWOSIDEDSTENCILMODE]: 0,
            [D3DRS_STENCILFUNC]: 3,
            [D3DRS_STENCILFAIL]: 2,
            [D3DRS_STENCILZFAIL]: 4,
            [D3DRS_STENCILPASS]: 3,
            [D3DRS_STENCILMASK]: 0xff,
            [D3DRS_STENCILWRITEMASK]: 0xff,
        };
        const state = buildDepthStencilState("depth24plus-stencil8", get(m));
        expect(state.stencilBack).toEqual(state.stencilFront);
    });
});

describe("stencil capability boundary", () => {
    test("keeps the attachment-aware stencil boundary explicit", () => {
        const m = defaults();
        expect(hasUnsupportedStencilState(get(m))).toBe(false);
        m[D3DRS_STENCILENABLE] = 1;
        expect(hasUnsupportedStencilState(get(m))).toBe(true);
        m[D3DRS_STENCILENABLE] = 0;
        m[D3DRS_TWOSIDEDSTENCILMODE] = 1;
        expect(hasUnsupportedStencilState(get(m))).toBe(true);
    });
});

describe("depth/stencil state validation", () => {
    function depthDefaults(): Record<number, number> {
        return {
            [D3DRS_CULLMODE]: 3, [D3DRS_ZENABLE]: 1, [D3DRS_ZFUNC]: 4,
            [D3DRS_STENCILENABLE]: 0, [D3DRS_TWOSIDEDSTENCILMODE]: 0,
            [D3DRS_STENCILFUNC]: 8, [D3DRS_STENCILFAIL]: 1,
            [D3DRS_STENCILZFAIL]: 1, [D3DRS_STENCILPASS]: 1,
            [D3DRS_CCW_STENCILFUNC]: 8, [D3DRS_CCW_STENCILFAIL]: 1,
            [D3DRS_CCW_STENCILZFAIL]: 1, [D3DRS_CCW_STENCILPASS]: 1,
        };
    }

    test("preserves valid default cull/depth state bits", () => {
        expect(isD3D9DepthStencilStateRepresentable(get(depthDefaults()))).toBe(true);
    });

    test("ignores malformed stencil enums while stencil is disabled", () => {
        const m = depthDefaults();
        m[D3DRS_STENCILFUNC] = 0xdead;
        m[D3DRS_STENCILFAIL] = 0xdead;
        expect(isD3D9DepthStencilStateRepresentable(get(m))).toBe(true);
    });

    test("refuses invalid active cull/depth/stencil enums", () => {
        const cull = depthDefaults(); cull[D3DRS_CULLMODE] = 0;
        expect(isD3D9DepthStencilStateRepresentable(get(cull))).toBe(false);
        const z = depthDefaults(); z[D3DRS_ZFUNC] = 0xdead;
        expect(isD3D9DepthStencilStateRepresentable(get(z))).toBe(false);
        const stencil = depthDefaults();
        stencil[D3DRS_STENCILENABLE] = 1;
        stencil[D3DRS_STENCILPASS] = 0xdead;
        expect(isD3D9DepthStencilStateRepresentable(get(stencil))).toBe(false);
        const back = depthDefaults();
        back[D3DRS_STENCILENABLE] = 1;
        back[D3DRS_TWOSIDEDSTENCILMODE] = 1;
        back[D3DRS_CCW_STENCILFUNC] = 0;
        expect(isD3D9DepthStencilStateRepresentable(get(back))).toBe(false);
    });
});

describe("D3DRS_BLENDFACTOR -> setBlendConstant", () => {
    test("decodes a D3DCOLOR as 0xAARRGGBB, not 0xAABBGGRR", () => {
        // The channel order is the whole bug: red and blue transposed renders every
        // D3DBLEND_BLENDFACTOR draw in the complementary hue and nothing errors.
        expect(d3dColorToGpu(0x80112233)).toEqual({
            r: 0x11 / 255,
            g: 0x22 / 255,
            b: 0x33 / 255,
            a: 0x80 / 255,
        });
        // Pure red must stay in the red channel.
        expect(d3dColorToGpu(0x00ff0000)).toEqual({ r: 1, g: 0, b: 0, a: 0 });
        expect(d3dColorToGpu(0x000000ff)).toEqual({ r: 0, g: 0, b: 1, a: 0 });
        // Sign-safe for a DWORD with the alpha high bit set.
        expect(d3dColorToGpu(0xffffffff | 0)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    });

    test("the executor applies the blend constant through that one decoder", () => {
        // The conversion has to happen where the render pass is encoded, so the numeric test
        // above cannot reach it. Pin the call instead: an open-coded channel decode in the
        // executor is exactly how the two halves drifted apart.
        const executor = readFileSync(join(import.meta.dir, "..", "..", "src", "worker",
            "backends", "webgpu", "d3d9", "d3d9-backend-executor.ts"), "utf8");
        const site = /setBlendConstant\(([\s\S]{0,200}?)\);/.exec(executor);
        expect(site).not.toBeNull();
        expect(site![1]).toContain("d3dColorToGpu");
    });
});
