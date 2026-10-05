/**
 * The per-draw sampler state a stage actually gets, and the bind-group fast path's idea of
 * "same sampler as last draw", must cover EVERY field getOrCreateStageSampler forwards.
 *
 * Two halves, both load-bearing:
 *  - prepareDraw copies D3DTSS_MIPMAPLODBIAS / MAXMIPLEVEL / BORDERCOLOR into the per-draw
 *    stage sampler record (they were dropped, so the decode and the "d3d9-border" mapping
 *    were dead).
 *  - the fast-path / batch-compatibility key includes them, or a draw changing only LOD bias,
 *    max mip level or border colour reuses the previous bind group.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
    STAGE_SAMPLER_KEY_LANES,
    writeStageSamplerKey,
} from "../../src/worker/backends/webgpu/ddraw/ddraw-backend-executor";
import type { StageSamplerState } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";

function sampler(overrides: Partial<StageSamplerState> = {}): StageSamplerState {
    return {
        minFilter: 2, magFilter: 2, mipFilter: 1, maxAnisotropy: 1,
        addressU: 1, addressV: 1,
        mipLodBiasBits: 0, maxMipLevel: 0, borderColor: 0,
        ...overrides,
    };
}

function key(sp: StageSamplerState | null): number[] {
    const out = new Int32Array(STAGE_SAMPLER_KEY_LANES);
    writeStageSamplerKey(out, 0, sp);
    return Array.from(out);
}

describe("stage sampler identity for the bind-group fast paths", () => {
    test("filter/address/anisotropy changes are distinguished (pre-existing behaviour)", () => {
        expect(key(sampler())).not.toEqual(key(sampler({ magFilter: 1 })));
        expect(key(sampler())).not.toEqual(key(sampler({ addressV: 2 })));
        expect(key(sampler())).not.toEqual(key(sampler({ maxAnisotropy: 8 })));
    });

    test("LOD bias, max mip level and border colour are distinguished too", () => {
        expect(key(sampler())).not.toEqual(key(sampler({ mipLodBiasBits: 0xbf800000 })));
        expect(key(sampler())).not.toEqual(key(sampler({ maxMipLevel: 2 })));
        expect(key(sampler())).not.toEqual(key(sampler({ borderColor: 0xff00ff00 })));
    });

    test("distinct raw DWORDs never collapse onto one key", () => {
        // Lanes, not a hash: these three would alias under any packing that folds 96 bits of
        // raw state into one word.
        const a = key(sampler({ mipLodBiasBits: 1, maxMipLevel: 0, borderColor: 0 }));
        const b = key(sampler({ mipLodBiasBits: 0, maxMipLevel: 1, borderColor: 0 }));
        const c = key(sampler({ mipLodBiasBits: 0, maxMipLevel: 0, borderColor: 1 }));
        expect(a).not.toEqual(b);
        expect(b).not.toEqual(c);
        expect(a).not.toEqual(c);
    });

    test("identical state produces an identical key, and an unsampled stage is marked -1", () => {
        expect(key(sampler({ borderColor: 7 }))).toEqual(key(sampler({ borderColor: 7 })));
        expect(key(null)[0]).toBe(-1);
    });

    test("the per-draw stage sampler copy carries all three fields", () => {
        // Structural: the executor's per-draw loop is what feeds the keys above and
        // getOrCreateStageSampler. Without these three assignments both are always 0.
        const src = readFileSync(
            "src/worker/backends/webgpu/ddraw/ddraw-backend-executor.ts", "utf8");
        expect(src).toContain("sp.mipLodBiasBits = stages.mipLodBiasBits[s];");
        expect(src).toContain("sp.maxMipLevel = stages.maxMipLevel[s];");
        expect(src).toContain("sp.borderColor = stages.borderColor[s];");
    });
});
