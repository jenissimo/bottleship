/**
 * A vertex declaration says WHERE components sit; SetStreamSource says how far apart
 * vertices are. Raising arrayStride to a packed size that overshoots the bound stride
 * reads every vertex after the first out of its successor, and sizes the draw past the
 * buffer's end — which WebGPU refuses, taking the whole frame's command buffer with it.
 */
import { describe, expect, test } from "bun:test";
import {
    parseFvf, planFvf, makeFvfDeclaration, D3DFVF_XYZ, D3DFVF_XYZRHW, D3DFVF_NORMAL, D3DFVF_DIFFUSE, D3DFVF_SPECULAR, D3DFVF_TEX1,
    D3DFVF_LASTBETA_UBYTE4,
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

    test("keeps all eight FVF coordinate sets with their declared dimensions", () => {
        // TEXCOUNT=8; set 1 FLOAT3, set 2 FLOAT4, set 3 FLOAT1, remaining sets FLOAT2.
        const fvf = D3DFVF_XYZ | (8 << 8) | (1 << 18) | (2 << 20) | (3 << 22);
        const p = planFvf(fvf);
        expect(p.hasTex).toBe(true);
        expect(p.hasTexSets).toEqual([true, true, true, true, true, true, true, true]);
        expect(p.texDims).toEqual([2, 3, 4, 1, 2, 2, 2, 2]);
        expect(p.attributes.slice(1).map(a => a.format)).toEqual([
            "float32x2", "float32x3", "float32x4", "float32",
            "float32x2", "float32x2", "float32x2", "float32x2",
        ]);
        expect(p.texOffsets).toEqual([12, 20, 32, 48, 52, 60, 68, 76]);
        expect(p.arrayStride).toBe(84);
    });

    test("does not mistake XYZB1 for pre-transformed XYZRHW", () => {
        const f = parseFvf(0x0006); // D3DFVF_XYZB1
        expect(f.hasRhw).toBe(false);
        expect(f.posOff).toBe(0);
        expect(f.stride).toBe(16);
    });

    test("exposes XYZBn beta weights without renumbering legacy attributes", () => {
        const f = parseFvf(0x0008 | D3DFVF_NORMAL | D3DFVF_TEX1); // XYZB2 + NORMAL + TEX1
        expect(f.blendWeightCount).toBe(2);
        expect(f.blendWeightOff).toBe(12);
        expect(f.blendWeightDims).toBe(2);
        expect(f.blendIndexLoc).toBe(-1);
        expect(f.normalOff).toBe(20);
        expect(f.texOffs[0]).toBe(32);
        expect(f.stride).toBe(40);
        expect(planFvf(0x0008 | D3DFVF_NORMAL | D3DFVF_TEX1).attributes.map(a => a.shaderLocation)).toEqual([0, 1, 2, 3]);
    });

    test("maps LASTBETA_UBYTE4 to a four-byte index attribute", () => {
        const f = parseFvf(0x000c | 0x1000); // XYZB4 + LASTBETA_UBYTE4
        expect(f.blendWeightCount).toBe(3);
        expect(f.blendWeightOff).toBe(12);
        expect(f.blendWeightDims).toBe(3);
        expect(f.blendIndexOff).toBe(24);
        expect(f.blendIndexFormat).toBe("uint8x4");
        const p = planFvf(0x000c | 0x1000);
        expect(p.attributes.map(a => a.format)).toEqual(["float32x3", "float32x3", "uint8x4"]);
        expect(p.arrayStride).toBe(28);
    });
});

describe("FVF programmable declaration", () => {
    test("preserves FLOAT1 and D3DCOLOR formats for a programmable VS", () => {
        // TEXCOORDSIZE1 is encoded as 3 in the first two-bit size field.
        const fvf = D3DFVF_XYZ | D3DFVF_DIFFUSE | D3DFVF_TEX1 | (3 << 16);
        const decl = makeFvfDeclaration(fvf)!;
        expect(decl).toEqual([
            { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0, reg: 0 },
            { stream: 0, offset: 12, type: 4, usage: 10, usageIndex: 0, reg: 1 },
            { stream: 0, offset: 16, type: 0, usage: 5, usageIndex: 0, reg: 2 },
        ]);
    });

    test("maps XYZBn last beta to BLENDWEIGHT + BLENDINDICES without losing offsets", () => {
        const decl = makeFvfDeclaration(0x000a | D3DFVF_LASTBETA_UBYTE4)!;
        expect(decl).toContainEqual({ stream: 0, offset: 12, type: 1, usage: 1, usageIndex: 0, reg: 1 });
        expect(decl).toContainEqual({ stream: 0, offset: 20, type: 5, usage: 2, usageIndex: 0, reg: 2 });
    });

    test("refuses five independent beta floats instead of fabricating a truncated element", () => {
        expect(makeFvfDeclaration(0x000e)).toBeNull();
    });
});
