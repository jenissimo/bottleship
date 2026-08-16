import { describe, expect, test } from "bun:test";
import {
    D3DSWAPEFFECT_COPY, D3DSWAPEFFECT_DISCARD, D3DSWAPEFFECT_FLIP,
    PP_SWAP_EFFECT, d3d9SwapEffectDiscardsBackBuffer, readD3d9SwapEffect,
} from "../../src/worker/modules/d3d9/presentation-params";

describe("D3D9 presentation parameters", () => {
    test("SwapEffect occupies ABI offset +24", () => {
        const view = new DataView(new ArrayBuffer(56));
        view.setUint32(PP_SWAP_EFFECT, D3DSWAPEFFECT_DISCARD, true);
        expect(readD3d9SwapEffect(view, 0)).toBe(D3DSWAPEFFECT_DISCARD);
    });

    test("only DISCARD invalidates the next backbuffer", () => {
        expect(d3d9SwapEffectDiscardsBackBuffer(D3DSWAPEFFECT_DISCARD)).toBe(true);
        expect(d3d9SwapEffectDiscardsBackBuffer(D3DSWAPEFFECT_FLIP)).toBe(false);
        expect(d3d9SwapEffectDiscardsBackBuffer(D3DSWAPEFFECT_COPY)).toBe(false);
        expect(d3d9SwapEffectDiscardsBackBuffer(0)).toBe(false);
    });
});
