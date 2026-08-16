/**
 * A vertex declaration says WHERE components sit; SetStreamSource says how far apart
 * vertices are. Raising arrayStride to a packed size that overshoots the bound stride
 * reads every vertex after the first out of its successor, and sizes the draw past the
 * buffer's end — which WebGPU refuses, taking the whole frame's command buffer with it.
 */
import { describe, expect, test } from "bun:test";
import {
    planFvf, D3DFVF_XYZ, D3DFVF_XYZRHW, D3DFVF_NORMAL, D3DFVF_DIFFUSE, D3DFVF_SPECULAR, D3DFVF_TEX1,
} from "../../src/worker/backends/webgpu/d3d9/shader/fvf-layout";

/** The rule under test, in the shape buildShaderFromDecl applies it. */
function layoutFor(packed: number, bound: number): number {
    return (bound > 0 ? bound : packed) || 12;
}

const attrSize = (format: string): number => {
    const m = /^(float|uint|sint|unorm|snorm)(8|16|32)(?:x(\d))?$/.exec(format);
    if (!m) return 16;
    return (Number(m[2]) / 8) * (m[3] ? Number(m[3]) : 1);
};

describe("declaration stride", () => {
    test("the bound stride wins over a larger packed size", () => {
        // A sprite ring: XYZ|DIFFUSE|TEX1 vertices bound at 24, a declaration
        // whose elements compute 32. Stepping by 32 walked off the end of a 4096*24 ring.
        expect(layoutFor(32, 24)).toBe(24);
    });

    test("the bound stride wins over a smaller packed size too", () => {
        // A vertex carrying data the declaration names no attribute for.
        expect(layoutFor(20, 32)).toBe(32);
    });

    test("packed size is the fallback only for an unbound stream", () => {
        expect(layoutFor(28, 0)).toBe(28);
        expect(layoutFor(0, 0)).toBe(12);
    });

    test("elements outside the bound vertex are dropped BEFORE the shader is emitted", () => {
        // Dropping them afterwards leaves the WGSL declaring @location(N) the vertex state
        // no longer supplies: WebGPU refuses the pipeline and every draw of the frame dies.
        const stride = layoutFor(32, 24);
        const attrs = [
            { offset: 0, format: "float32x3" },   // 12 -> fits
            { offset: 12, format: "unorm8x4" },   // 16 -> fits
            { offset: 16, format: "float32x2" },  // 24 -> fits exactly
            { offset: 24, format: "float32x2" },  // 32 -> outside
        ];
        const fits = attrs.filter(a => a.offset + attrSize(a.format) <= stride);
        expect(fits.length).toBe(3);
        expect(fits.at(-1)!.offset).toBe(16);
    });

    test("attribute sizes are read from the format, not guessed", () => {
        expect(attrSize("float32x3")).toBe(12);
        expect(attrSize("unorm8x4")).toBe(4);
        expect(attrSize("float32")).toBe(4);
        expect(attrSize("float16x4")).toBe(8);
    });
});

/**
 * The same rule on the FVF path, where the shader's WGSL inputs and the attribute list are
 * emitted from ONE plan — a component dropped for not fitting the bound vertex has to vanish
 * from both, or WebGPU rejects a pipeline whose shader declares a @location the vertex state
 * cannot supply.
 */
describe("FVF stride", () => {
    const XYZ_DIFFUSE_TEX1 = D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1;   // packed 24
    const locOf = (p: ReturnType<typeof planFvf>, loc: number) =>
        p.attributes.find(a => a.shaderLocation === loc) ?? null;

    test("the bound stride wins over the FVF's packed size", () => {
        // A vertex carrying data the FVF names no component for.
        expect(planFvf(XYZ_DIFFUSE_TEX1, 32).arrayStride).toBe(32);
        // And the other way: stepping by 24 where the guest bound 20 reads every vertex after
        // the first out of its successor.
        expect(planFvf(XYZ_DIFFUSE_TEX1, 20).arrayStride).toBe(20);
    });

    test("the packed size is the fallback for an unbound stream only", () => {
        expect(planFvf(XYZ_DIFFUSE_TEX1, 0).arrayStride).toBe(24);
    });

    test("a component outside the bound vertex is dropped from BOTH halves", () => {
        // 20 bytes holds XYZ (12) + DIFFUSE (16) but not the texcoord ending at 24.
        const p = planFvf(XYZ_DIFFUSE_TEX1, 20);
        expect(p.hasColor).toBe(true);
        expect(p.hasTex).toBe(false);
        expect(locOf(p, p.texLoc)).toBeNull();
        expect(p.attributes.length).toBe(2);
    });

    test("everything fits when the bound stride is the packed size", () => {
        const p = planFvf(XYZ_DIFFUSE_TEX1, 24);
        expect(p.hasColor).toBe(true);
        expect(p.hasTex).toBe(true);
        expect(p.attrEnd).toBe(24);
    });

    test("position is exempt — a stride too small for it is raised, not honoured", () => {
        // Nothing is salvageable from a draw with no position, so this one case keeps the
        // packed stride rather than dropping the attribute.
        const p = planFvf(D3DFVF_XYZRHW | D3DFVF_DIFFUSE, 8);
        expect(p.arrayStride).toBe(20);
        expect(p.attributes[0]!.format).toBe("float32x4");
    });

    test("attrEnd tracks the furthest KEPT attribute, not the vertex", () => {
        expect(planFvf(XYZ_DIFFUSE_TEX1, 32).attrEnd).toBe(24);
        expect(planFvf(XYZ_DIFFUSE_TEX1, 20).attrEnd).toBe(16);
    });

    test("shader locations of the surviving components are unchanged", () => {
        // The FVF's location assignment is positional; dropping a component must not renumber
        // the ones before it (the WGSL is emitted from these same numbers).
        const full = planFvf(D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR | D3DFVF_TEX1);
        expect([full.posLoc, full.normalLoc, full.colorLoc, full.specularLoc, full.texLoc]).toEqual([0, 1, 2, 3, 4]);
        const short = planFvf(D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_DIFFUSE | D3DFVF_SPECULAR | D3DFVF_TEX1, 32);
        expect(short.hasSpecular).toBe(true);
        expect(short.hasTex).toBe(false);
        expect(locOf(short, 3)!.offset).toBe(28);
    });
});
