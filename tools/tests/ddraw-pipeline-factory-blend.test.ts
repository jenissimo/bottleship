import { describe, expect, test } from "bun:test";
import {
    mapBlendFactor, mapBlendOperation, resolveBlendFactors,
    sanitizeBlendFactor, sanitizeBlendOperation,
} from "../../src/worker/backends/webgpu/ddraw/pipeline-factory";

// D3DBLEND_* (d3d8types.h / d3d9types.h — identical values across D3D3-9).
const ZERO = 1, ONE = 2, SRCCOLOR = 3, INVSRCCOLOR = 4, SRCALPHA = 5, INVSRCALPHA = 6,
    DESTALPHA = 7, INVDESTALPHA = 8, DESTCOLOR = 9, INVDESTCOLOR = 10, SRCALPHASAT = 11,
    BOTHSRCALPHA = 12, BOTHINVSRCALPHA = 13, BLENDFACTOR = 14, INVBLENDFACTOR = 15,
    SRCCOLOR2 = 16, INVSRCCOLOR2 = 17;

// D3DBLENDOP_*
const OP_ADD = 1, OP_SUBTRACT = 2, OP_REVSUBTRACT = 3, OP_MIN = 4, OP_MAX = 5;

describe("PipelineFactory mapBlendFactor — every D3DBLEND value", () => {
    const cases: [number, GPUBlendFactor][] = [
        [ZERO, "zero"],
        [ONE, "one"],
        [SRCCOLOR, "src"],
        [INVSRCCOLOR, "one-minus-src"],
        [SRCALPHA, "src-alpha"],
        [INVSRCALPHA, "one-minus-src-alpha"],
        [DESTALPHA, "dst-alpha"],
        [INVDESTALPHA, "one-minus-dst-alpha"],
        [DESTCOLOR, "dst"],
        [INVDESTCOLOR, "one-minus-dst"],
        [SRCALPHASAT, "src-alpha-saturated"],
        [BLENDFACTOR, "constant"],
        [INVBLENDFACTOR, "one-minus-constant"],
    ];
    for (const [d3d, gpu] of cases) {
        test(`D3DBLEND ${d3d} -> "${gpu}"`, () => {
            expect(mapBlendFactor(d3d)).toBe(gpu);
        });
    }

    test("SRCALPHASAT was previously missing — now reported, not defaulted", () => {
        // Regression pin: SRCALPHASAT(11) must resolve to its own factor, not fall
        // through to "src-alpha" (SRCALPHA=5) the way the old default branch did.
        expect(mapBlendFactor(SRCALPHASAT)).toBe("src-alpha-saturated");
        expect(mapBlendFactor(SRCALPHASAT)).not.toBe(mapBlendFactor(SRCALPHA));
    });

    test("DESTCOLOR/INVDESTCOLOR were previously missing — now reported, not defaulted", () => {
        expect(mapBlendFactor(DESTCOLOR)).toBe("dst");
        expect(mapBlendFactor(INVDESTCOLOR)).toBe("one-minus-dst");
    });

    test("BLENDFACTOR/INVBLENDFACTOR were previously missing — now reported, not defaulted", () => {
        expect(mapBlendFactor(BLENDFACTOR)).toBe("constant");
        expect(mapBlendFactor(INVBLENDFACTOR)).toBe("one-minus-constant");
    });

    test("refuses dual-source factors instead of aliasing them to the first source", () => {
        expect(() => mapBlendFactor(SRCCOLOR2)).toThrow();
        expect(() => mapBlendFactor(INVSRCCOLOR2)).toThrow();
    });

    test("refuses an out-of-range D3DBLEND enum instead of silently mapping it to src-alpha", () => {
        // This is F1's exact failure mode: default: return "src-alpha" swallowed
        // BOTHSRCALPHA(12)/BOTHINVSRCALPHA(13) along with any genuinely bogus value.
        expect(() => mapBlendFactor(0)).toThrow();
        expect(() => mapBlendFactor(0xdead)).toThrow();
        expect(() => mapBlendFactor(-1)).toThrow();
    });
});

describe("PipelineFactory mapBlendOperation — every D3DBLENDOP value", () => {
    const cases: [number, GPUBlendOperation][] = [
        [OP_ADD, "add"],
        [OP_SUBTRACT, "subtract"],
        [OP_REVSUBTRACT, "reverse-subtract"],
        [OP_MIN, "min"],
        [OP_MAX, "max"],
    ];
    for (const [d3d, gpu] of cases) {
        test(`D3DBLENDOP ${d3d} -> "${gpu}"`, () => {
            expect(mapBlendOperation(d3d)).toBe(gpu);
        });
    }

    test("refuses an out-of-range D3DBLENDOP instead of silently mapping it to ADD", () => {
        expect(() => mapBlendOperation(0)).toThrow();
        expect(() => mapBlendOperation(6)).toThrow();
        expect(() => mapBlendOperation(0xdead)).toThrow();
    });
});

describe("PipelineFactory resolveBlendFactors — DirectX-6 BOTH*SRCALPHA fixup", () => {
    // The exact bug from docs/d3d8-parity/07-unification-map.md F1 / §2.1: SRCBLEND
    // naming a BOTH* legacy value must EXPAND into an (src,dst) pair and DESTBLEND
    // must be ignored outright, whatever value the game left there.
    test("BOTHSRCALPHA(12) resolves to (SRCALPHA, INVSRCALPHA) regardless of DESTBLEND", () => {
        for (const dstBlendFromGame of [ZERO, ONE, DESTCOLOR, 0, 0xdead]) {
            const [src, dst] = resolveBlendFactors(BOTHSRCALPHA, dstBlendFromGame, ONE, ZERO);
            expect(src).toBe(SRCALPHA);
            expect(dst).toBe(INVSRCALPHA);
        }
    });

    test("BOTHINVSRCALPHA(13) resolves to (INVSRCALPHA, SRCALPHA) regardless of DESTBLEND", () => {
        for (const dstBlendFromGame of [ZERO, ONE, DESTCOLOR, 0, 0xdead]) {
            const [src, dst] = resolveBlendFactors(BOTHINVSRCALPHA, dstBlendFromGame, ONE, ZERO);
            expect(src).toBe(INVSRCALPHA);
            expect(dst).toBe(SRCALPHA);
        }
    });

    test("both fixed-up pairs are round-trippable through mapBlendFactor", () => {
        const [srcA, dstA] = resolveBlendFactors(BOTHSRCALPHA, ONE, ONE, ZERO);
        expect(mapBlendFactor(srcA)).toBe("src-alpha");
        expect(mapBlendFactor(dstA)).toBe("one-minus-src-alpha");

        const [srcB, dstB] = resolveBlendFactors(BOTHINVSRCALPHA, ONE, ONE, ZERO);
        expect(mapBlendFactor(srcB)).toBe("one-minus-src-alpha");
        expect(mapBlendFactor(dstB)).toBe("src-alpha");
    });

    test("non-BOTH* factors pass through DESTBLEND unchanged", () => {
        expect(resolveBlendFactors(SRCALPHA, INVSRCALPHA, ONE, ZERO)).toEqual([SRCALPHA, INVSRCALPHA]);
        expect(resolveBlendFactors(ONE, ONE, ONE, ZERO)).toEqual([ONE, ONE]);
    });

    test("unwritten-state (0) render-state DWORDs fall back to the D3D7 defaults ONE/ZERO", () => {
        expect(resolveBlendFactors(0, 0, ONE, ZERO)).toEqual([ONE, ZERO]);
    });

    test("an unwritten SRCBLEND (0) does not accidentally trigger the BOTH* fixup", () => {
        // 0 || defaultSrc resolves to the caller's default (ONE=2) before fixupBoth ever
        // sees it, so this must NOT match the BOTHSRCALPHA(12)/BOTHINVSRCALPHA(13) branches.
        const [src, dst] = resolveBlendFactors(0, 0, ONE, ZERO);
        expect(src).not.toBe(SRCALPHA);
        expect(dst).not.toBe(INVSRCALPHA);
    });
});

describe("a per-draw path never throws on guest blend state", () => {
    // getOrCreatePipeline runs inside an OPEN render pass: an exception escaping it loses the
    // whole frame's command buffer (every draw and every upload on that encoder). Render state
    // is guest-writable, so a stale/garbage DWORD must degrade, the way DXVK's decoders do.
    const garbage = [0, 18, 255, 0xdead, -1, 0x7fffffff];

    test("sanitizeBlendFactor maps every out-of-range enum to ZERO (DXVK DecodeBlendFactor)", () => {
        for (const bad of garbage) expect(sanitizeBlendFactor(bad)).toBe(ZERO);
    });

    test("sanitizeBlendFactor degrades dual-source to its single-source counterpart", () => {
        expect(sanitizeBlendFactor(SRCCOLOR2)).toBe(SRCCOLOR);
        expect(sanitizeBlendFactor(INVSRCCOLOR2)).toBe(INVSRCCOLOR);
    });

    test("sanitizeBlendFactor leaves every legal factor untouched", () => {
        for (let f = ZERO; f <= INVBLENDFACTOR; f++) expect(sanitizeBlendFactor(f)).toBe(f);
    });

    test("sanitizeBlendOperation maps an out-of-range D3DBLENDOP to ADD", () => {
        for (const bad of [0, 6, 0xdead, -1]) expect(sanitizeBlendOperation(bad)).toBe(OP_ADD);
        for (let op = OP_ADD; op <= OP_MAX; op++) expect(sanitizeBlendOperation(op)).toBe(op);
    });

    test("the resolved (src,dst) pair a draw builds its pipeline from is always mappable", () => {
        // This is the exact composition the draw path runs: render-state DWORDs ->
        // resolveBlendFactors -> mapBlendFactor inside createPipeline. Before the fix a
        // garbage SRCBLEND/DESTBLEND reached mapBlendFactor and threw out of the draw.
        for (const src of [...garbage, SRCCOLOR2, BOTHSRCALPHA, SRCALPHA]) {
            for (const dst of [...garbage, INVSRCCOLOR2, INVSRCALPHA]) {
                const [rs, rd] = resolveBlendFactors(src, dst, ONE, ZERO);
                expect(() => mapBlendFactor(rs)).not.toThrow();
                expect(() => mapBlendFactor(rd)).not.toThrow();
            }
        }
    });

    test("the blend operation a draw builds its pipeline from is always mappable", () => {
        for (const op of [0, 6, 0xdead, -1, OP_MIN]) {
            expect(() => mapBlendOperation(sanitizeBlendOperation(op))).not.toThrow();
        }
    });
});
