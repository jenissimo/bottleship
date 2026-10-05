import { describe, expect, test, beforeEach } from "bun:test";
import {
    D3D9_RENDER_STATE_CLASS, D3D9_RENDER_STATE_COUNT, D3D9_RENDER_STATE_NAMES,
    D3D9_RS_BLEND, D3D9_RS_CONSERVATIVE, D3D9_RS_DEPTH_STENCIL, D3D9_RS_OTHER,
    D3D9_RS_RASTERIZER, D3D9_RS_SAMPLE, D3D9_RS_SUBKEY_MASK, D3D9_RS_UNCLASSIFIED,
    D3D9_RS_UNIFORM,
    classifyD3D9RenderStateWrite, d3d9RenderStateAffectsPipeline, d3d9RenderStateClass,
    d3d9RenderStateIsUnclassified, d3d9RenderStateIsUniform, d3d9RenderStateName,
    d3d9UnclassifiedRenderStateStats,
} from "../../src/worker/modules/d3d9/render-state-class";
import {
    D3DRS_ALPHABLENDENABLE, D3DRS_BLENDFACTOR, D3DRS_BLENDOP, D3DRS_BLENDOPALPHA,
    D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILFUNC, D3DRS_CCW_STENCILPASS, D3DRS_CCW_STENCILZFAIL,
    D3DRS_COLORWRITEENABLE, D3DRS_COLORWRITEENABLE1, D3DRS_COLORWRITEENABLE2,
    D3DRS_COLORWRITEENABLE3, D3DRS_CULLMODE, D3DRS_DEPTHBIAS, D3DRS_DESTBLEND,
    D3DRS_DESTBLENDALPHA, D3DRS_SEPARATEALPHABLENDENABLE, D3DRS_SLOPESCALEDEPTHBIAS,
    D3DRS_SRCBLEND, D3DRS_SRCBLENDALPHA, D3DRS_STENCILENABLE, D3DRS_STENCILFAIL,
    D3DRS_STENCILFUNC, D3DRS_STENCILMASK, D3DRS_STENCILPASS, D3DRS_STENCILWRITEMASK,
    D3DRS_STENCILZFAIL, D3DRS_TWOSIDEDSTENCILMODE, D3DRS_ZENABLE, D3DRS_ZFUNC,
    D3DRS_ZWRITEENABLE,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-blend";
import {
    D3DRS_ANTIALIASEDLINEENABLE, D3DRS_MULTISAMPLEANTIALIAS, D3DRS_MULTISAMPLEMASK,
    D3DRS_POINTSIZE, D3DRS_POINTSPRITEENABLE,
} from "../../src/worker/backends/webgpu/d3d9/raster-emulation";

const B = D3D9_RS_BLEND, D = D3D9_RS_DEPTH_STENCIL, R = D3D9_RS_RASTERIZER,
    S = D3D9_RS_SAMPLE, O = D3D9_RS_OTHER, U = D3D9_RS_UNIFORM;

/**
 * The pinned classification — a SECOND, independent transcription of the table, written from
 * the D3D9 ordinals rather than imported from the module under test. A silent edit to
 * render-state-class.ts fails here; a deliberate one has to be made twice.
 */
const EXPECTED: ReadonlyArray<readonly [number, string, number]> = [
    // depth / stencil
    [7, "ZENABLE", D | R],
    [14, "ZWRITEENABLE", D],
    [23, "ZFUNC", D],
    [52, "STENCILENABLE", D],
    [53, "STENCILFAIL", D],
    [54, "STENCILZFAIL", D],
    [55, "STENCILPASS", D],
    [56, "STENCILFUNC", D],
    [57, "STENCILREF", U],
    [58, "STENCILMASK", D],
    [59, "STENCILWRITEMASK", D],
    [175, "SLOPESCALEDEPTHBIAS", D],
    [185, "TWOSIDEDSTENCILMODE", D],
    [186, "CCW_STENCILFAIL", D],
    [187, "CCW_STENCILZFAIL", D],
    [188, "CCW_STENCILPASS", D],
    [189, "CCW_STENCILFUNC", D],
    [195, "DEPTHBIAS", D],
    // blend / output merger
    [19, "SRCBLEND", B],
    [20, "DESTBLEND", B],
    [27, "ALPHABLENDENABLE", B],
    [168, "COLORWRITEENABLE", B],
    [171, "BLENDOP", B],
    [190, "COLORWRITEENABLE1", B],
    [191, "COLORWRITEENABLE2", B],
    [192, "COLORWRITEENABLE3", B],
    [193, "BLENDFACTOR", U],
    [194, "SRGBWRITEENABLE", B],
    [206, "SEPARATEALPHABLENDENABLE", B],
    [207, "SRCBLENDALPHA", B],
    [208, "DESTBLENDALPHA", B],
    [209, "BLENDOPALPHA", B],
    // rasterizer
    [8, "FILLMODE", R],
    [16, "LASTPIXEL", U],
    [22, "CULLMODE", R],
    [26, "DITHERENABLE", U],
    [136, "CLIPPING", R],
    [174, "SCISSORTESTENABLE", U],
    [176, "ANTIALIASEDLINEENABLE", R],
    // multisample
    [161, "MULTISAMPLEANTIALIAS", S],
    [162, "MULTISAMPLEMASK", S],
    // shader permutation / other pipeline identity
    [9, "SHADEMODE", O],
    [15, "ALPHATESTENABLE", O],
    [24, "ALPHAREF", O],
    [25, "ALPHAFUNC", O],
    [28, "FOGENABLE", O],
    [35, "FOGTABLEMODE", O],
    [48, "RANGEFOGENABLE", O],
    [128, "WRAP0", O],
    [129, "WRAP1", O],
    [130, "WRAP2", O],
    [131, "WRAP3", O],
    [132, "WRAP4", O],
    [133, "WRAP5", O],
    [134, "WRAP6", O],
    [135, "WRAP7", O],
    [137, "LIGHTING", O],
    [140, "FOGVERTEXMODE", O],
    [151, "VERTEXBLEND", O],
    [152, "CLIPPLANEENABLE", O],
    [153, "SOFTWAREVERTEXPROCESSING", O],
    [156, "POINTSPRITEENABLE", O],
    [157, "POINTSCALEENABLE", O],
    [163, "PATCHEDGESTYLE", O],
    [167, "INDEXEDVERTEXBLENDENABLE", O],
    [172, "POSITIONDEGREE", O],
    [173, "NORMALDEGREE", O],
    [178, "MINTESSELLATIONLEVEL", O],
    [179, "MAXTESSELLATIONLEVEL", O],
    [180, "ADAPTIVETESS_X", O],
    [181, "ADAPTIVETESS_Y", O | S],
    [182, "ADAPTIVETESS_Z", O],
    [183, "ADAPTIVETESS_W", O],
    [184, "ENABLEADAPTIVETESSELLATION", O],
    [198, "WRAP8", O],
    [199, "WRAP9", O],
    [200, "WRAP10", O],
    [201, "WRAP11", O],
    [202, "WRAP12", O],
    [203, "WRAP13", O],
    [204, "WRAP14", O],
    [205, "WRAP15", O],
    // uniform / bank-only
    [29, "SPECULARENABLE", U],
    [34, "FOGCOLOR", U],
    [36, "FOGSTART", U],
    [37, "FOGEND", U],
    [38, "FOGDENSITY", U],
    [60, "TEXTUREFACTOR", U],
    [139, "AMBIENT", U],
    [141, "COLORVERTEX", U],
    [142, "LOCALVIEWER", U],
    [143, "NORMALIZENORMALS", U],
    [145, "DIFFUSEMATERIALSOURCE", U],
    [146, "SPECULARMATERIALSOURCE", U],
    [147, "AMBIENTMATERIALSOURCE", U],
    [148, "EMISSIVEMATERIALSOURCE", U],
    [154, "POINTSIZE", U],
    [155, "POINTSIZE_MIN", U],
    [158, "POINTSCALE_A", U],
    [159, "POINTSCALE_B", U],
    [160, "POINTSCALE_C", U],
    [165, "DEBUGMONITORTOKEN", U],
    [166, "POINTSIZE_MAX", U],
    [170, "TWEENFACTOR", U],
];

/** Ordinals the table deliberately does NOT classify (D3D8/D3D7-only, or an undefined gap). */
const DELIBERATELY_UNCLASSIFIED = [
    0, 1, 10 /* D3D8 LINEPATTERN */, 40 /* D3D8 EDGEANTIALIAS */, 41 /* D3D8 COLORKEYENABLE */,
    44 /* D3D7 ZVISIBLE */, 47 /* D3D8 ZBIAS */, 90 /* undefined gap */,
    164 /* D3D8 PATCHSEGMENTS */, 255,
];

beforeEach(() => { d3d9UnclassifiedRenderStateStats(true); });

describe("D3D9 render-state pipeline classification", () => {
    test("the table is a flat 256-entry lookup", () => {
        expect(D3D9_RENDER_STATE_CLASS).toBeInstanceOf(Uint8Array);
        expect(D3D9_RENDER_STATE_CLASS.length).toBe(D3D9_RENDER_STATE_COUNT);
        expect(D3D9_RENDER_STATE_NAMES.length).toBe(D3D9_RENDER_STATE_COUNT);
        expect(D3D9_RENDER_STATE_COUNT).toBe(256);
    });

    test("every covered state is pinned to its class and sub-key", () => {
        for (const [ordinal, name, mask] of EXPECTED) {
            expect({ ordinal, name: d3d9RenderStateName(ordinal), mask: d3d9RenderStateClass(ordinal) })
                .toEqual({ ordinal, name, mask });
        }
    });

    test("the pinned list and the shipped table cover exactly the same ordinals", () => {
        const pinned = new Set(EXPECTED.map(([ordinal]) => ordinal));
        const shipped = new Set<number>();
        for (let i = 0; i < D3D9_RENDER_STATE_COUNT; i++) {
            if (!d3d9RenderStateIsUnclassified(i)) shipped.add(i);
        }
        expect([...shipped].sort((a, b) => a - b)).toEqual([...pinned].sort((a, b) => a - b));
    });

    test("class and sub-key bits are consistent for every covered state", () => {
        for (const [ordinal] of EXPECTED) {
            const mask = d3d9RenderStateClass(ordinal);
            // A classified state never carries the unclassified marker...
            expect(mask & D3D9_RS_UNCLASSIFIED).toBe(0);
            // ...never sets a bit outside the sub-key space...
            expect(mask & ~D3D9_RS_SUBKEY_MASK).toBe(0);
            // ...and uniform/pipeline is exactly "no sub-key"/"some sub-key".
            expect(d3d9RenderStateIsUniform(ordinal)).toBe(mask === 0);
            expect(d3d9RenderStateAffectsPipeline(ordinal)).toBe(mask !== 0);
            // A classified state has a name; the name lookup never falls through.
            expect(d3d9RenderStateName(ordinal)).not.toMatch(/^RS\(/);
        }
    });
});

describe("the conservative default", () => {
    test("an unclassified ordinal bumps EVERY sub-key and is marked", () => {
        for (const ordinal of DELIBERATELY_UNCLASSIFIED) {
            expect(d3d9RenderStateClass(ordinal)).toBe(D3D9_RS_CONSERVATIVE);
            expect(d3d9RenderStateIsUnclassified(ordinal)).toBe(true);
            // Conservative means pipeline-affecting, never uniform: a wrong pipeline is the
            // one failure mode this default exists to make impossible.
            expect(d3d9RenderStateAffectsPipeline(ordinal)).toBe(true);
            expect(d3d9RenderStateIsUniform(ordinal)).toBe(false);
            expect(classifyD3D9RenderStateWrite(ordinal)).toBe(D3D9_RS_SUBKEY_MASK);
        }
    });

    test("D3DRS_ZBIAS (47) is unclassified on purpose — d3d8to9 converts it upstream", () => {
        // Named separately from the loop above because it is the one ordinal a real title is
        // plausibly going to hit; seeing it in the census is a finding about the wrapper.
        expect(d3d9RenderStateIsUnclassified(47)).toBe(true);
        expect(d3d9RenderStateName(47)).toBe("RS(47)");
    });

    test("an out-of-range ordinal answers conservatively rather than undefined", () => {
        for (const ordinal of [256, 1024, 0xffffffff]) {
            expect(d3d9RenderStateClass(ordinal)).toBe(D3D9_RS_CONSERVATIVE);
            expect(d3d9RenderStateAffectsPipeline(ordinal)).toBe(true);
        }
    });

    test("unclassified writes are counted and named; classified writes are not", () => {
        expect(d3d9UnclassifiedRenderStateStats().total).toBe(0);
        expect(d3d9UnclassifiedRenderStateStats().verdict).toBe("no unclassified render-state writes");

        // Classified writes must leave the census alone, or the counter measures traffic
        // rather than gaps.
        for (const [ordinal] of EXPECTED) classifyD3D9RenderStateWrite(ordinal);
        expect(d3d9UnclassifiedRenderStateStats().total).toBe(0);

        classifyD3D9RenderStateWrite(47);
        classifyD3D9RenderStateWrite(47);
        classifyD3D9RenderStateWrite(10);
        const stats = d3d9UnclassifiedRenderStateStats();
        expect(stats.total).toBe(3);
        expect(stats.distinct).toBe(2);
        expect(stats.states[0]).toEqual({ state: 47, name: "RS(47)", count: 2 });
        expect(stats.verdict).toContain("RS(47)x2");

        expect(d3d9UnclassifiedRenderStateStats(true).total).toBe(3);
        expect(d3d9UnclassifiedRenderStateStats().total).toBe(0);
    });

    test("the pure lookup does not record a census entry", () => {
        // d3d9RenderStateClass is read on resolve paths too; if it counted, a probe would
        // inflate the ingest census it is supposed to report.
        d3d9RenderStateClass(47);
        d3d9RenderStateIsUnclassified(47);
        d3d9RenderStateAffectsPipeline(47);
        expect(d3d9UnclassifiedRenderStateStats().total).toBe(0);
    });
});

describe("cross-check against the states the backend already keys on", () => {
    // Every state read by computeBlendKey / computeDepthKey / rasterStateKey reaches a
    // pipeline descriptor today, so it is pipeline-affecting BY CONSTRUCTION. The ordinals
    // are imported from the backend modules, so a renumbering there fails here rather than
    // leaving this table pointing at the wrong slot.
    test("blend-key states are classified BLEND", () => {
        for (const state of [
            D3DRS_SRCBLEND, D3DRS_DESTBLEND, D3DRS_ALPHABLENDENABLE, D3DRS_BLENDOP,
            D3DRS_SEPARATEALPHABLENDENABLE, D3DRS_SRCBLENDALPHA, D3DRS_DESTBLENDALPHA,
            D3DRS_BLENDOPALPHA, D3DRS_COLORWRITEENABLE, D3DRS_COLORWRITEENABLE1,
            D3DRS_COLORWRITEENABLE2, D3DRS_COLORWRITEENABLE3,
        ]) {
            expect(d3d9RenderStateClass(state) & D3D9_RS_BLEND).toBe(D3D9_RS_BLEND);
        }
    });

    test("depth-key states are classified DEPTH_STENCIL", () => {
        for (const state of [
            D3DRS_ZENABLE, D3DRS_ZWRITEENABLE, D3DRS_ZFUNC, D3DRS_STENCILENABLE,
            D3DRS_STENCILFAIL, D3DRS_STENCILZFAIL, D3DRS_STENCILPASS, D3DRS_STENCILFUNC,
            D3DRS_STENCILMASK, D3DRS_STENCILWRITEMASK, D3DRS_TWOSIDEDSTENCILMODE,
            D3DRS_CCW_STENCILFAIL, D3DRS_CCW_STENCILZFAIL, D3DRS_CCW_STENCILPASS,
            D3DRS_CCW_STENCILFUNC, D3DRS_SLOPESCALEDEPTHBIAS, D3DRS_DEPTHBIAS,
        ]) {
            expect(d3d9RenderStateClass(state) & D3D9_RS_DEPTH_STENCIL).toBe(D3D9_RS_DEPTH_STENCIL);
        }
    });

    test("raster/sample states are classified RASTERIZER / SAMPLE", () => {
        expect(d3d9RenderStateClass(D3DRS_CULLMODE) & D3D9_RS_RASTERIZER).toBe(D3D9_RS_RASTERIZER);
        expect(d3d9RenderStateClass(D3DRS_ANTIALIASEDLINEENABLE) & D3D9_RS_RASTERIZER).toBe(D3D9_RS_RASTERIZER);
        expect(d3d9RenderStateClass(D3DRS_MULTISAMPLEANTIALIAS) & D3D9_RS_SAMPLE).toBe(D3D9_RS_SAMPLE);
        expect(d3d9RenderStateClass(D3DRS_MULTISAMPLEMASK) & D3D9_RS_SAMPLE).toBe(D3D9_RS_SAMPLE);
        expect(d3d9RenderStateClass(D3DRS_POINTSPRITEENABLE) & D3D9_RS_OTHER).toBe(D3D9_RS_OTHER);
    });

    test("the two dynamic render-pass states stay OUT of the key", () => {
        // setBlendConstant / setStencilReference are per-draw commands. Keying on them is the
        // exact FOGCOLOR mistake §3 names, one descriptor section over.
        expect(d3d9RenderStateIsUniform(D3DRS_BLENDFACTOR)).toBe(true);
        expect(d3d9RenderStateIsUniform(57 /* D3DRS_STENCILREF */)).toBe(true);
        // ...and so does the §3 example itself.
        expect(d3d9RenderStateIsUniform(34 /* D3DRS_FOGCOLOR */)).toBe(true);
        // A point SIZE is a uniform; the point SPRITE enable is a shader permutation.
        expect(d3d9RenderStateIsUniform(D3DRS_POINTSIZE)).toBe(true);
    });
});
