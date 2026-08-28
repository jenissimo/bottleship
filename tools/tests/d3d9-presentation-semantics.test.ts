import { describe, expect, test } from "bun:test";
import {
    D3D9PresentationState,
    D3DPRESENT_INTERVAL_DEFAULT,
    D3DPRESENT_INTERVAL_FOUR,
    D3DPRESENT_INTERVAL_IMMEDIATE,
    D3DPRESENT_INTERVAL_THREE,
    D3DPRESENT_INTERVAL_TWO,
    D3DSWAPEFFECT_COPY,
    D3DSWAPEFFECT_DISCARD,
    D3DSWAPEFFECT_FLIP,
    D3DSWAPEFFECT_FLIPEX,
    defaultPresentationParameters9,
    decodePresentationInterval9,
    isIdentityGammaRamp9,
    parseGammaRamp9,
    summarizeDirtyRegion9,
    validatePresentationParameters9,
    writeGammaRamp9,
} from "../../src/worker/backends/webgpu/d3d9/presentation";

describe("D3D9 presentation observable semantics", () => {
    test("validates the Ex-only swap effect, count, interval and quality rules", () => {
        const base = defaultPresentationParameters9();
        expect(validatePresentationParameters9({
            ...base,
            swapEffect: D3DSWAPEFFECT_FLIPEX,
        }, false)).toBe(0x8876086c);
        expect(validatePresentationParameters9({
            ...base,
            swapEffect: D3DSWAPEFFECT_FLIPEX,
            backBufferCount: 30,
        }, true)).toBe(0);
        expect(validatePresentationParameters9({
            ...base,
            swapEffect: D3DSWAPEFFECT_COPY,
            backBufferCount: 2,
        }, false)).toBe(0x8876086c);
        expect(validatePresentationParameters9({
            ...base,
            windowed: true,
            presentationInterval: D3DPRESENT_INTERVAL_TWO,
        })).toBe(0x8876086c);
        expect(validatePresentationParameters9({
            ...base,
            multiSampleQuality: 1,
        })).toBe(0x8876086a);
    });

    test("decodes ABI interval bit values, including DEFAULT and IMMEDIATE", () => {
        expect(decodePresentationInterval9(D3DPRESENT_INTERVAL_DEFAULT)).toBe(1);
        expect(decodePresentationInterval9(1)).toBe(1);
        expect(decodePresentationInterval9(D3DPRESENT_INTERVAL_TWO)).toBe(2);
        expect(decodePresentationInterval9(D3DPRESENT_INTERVAL_THREE)).toBe(3);
        expect(decodePresentationInterval9(D3DPRESENT_INTERVAL_FOUR)).toBe(4);
        expect(decodePresentationInterval9(D3DPRESENT_INTERVAL_IMMEDIATE)).toBe(0);
        expect(decodePresentationInterval9(3)).toBeNull();
        expect(decodePresentationInterval9(5)).toBeNull();
    });

    test("keeps null, empty and bounded dirty regions distinct", () => {
        expect(summarizeDirtyRegion9(null)).toEqual({ kind: "full", bounds: null, rectCount: 0 });
        expect(summarizeDirtyRegion9([])).toEqual({ kind: "empty", bounds: null, rectCount: 0 });
        expect(summarizeDirtyRegion9([
            { left: 10, top: 20, right: 30, bottom: 40 },
            { left: 0, top: 25, right: 12, bottom: 50 },
        ])).toEqual({
            kind: "rects",
            bounds: { left: 0, top: 20, right: 30, bottom: 50 },
            rectCount: 2,
        });
    });

    test("gamma ramp parser/writer preserves all 1536 bytes and detects identity", () => {
        const memory = new Uint8Array(2048);
        const ramp = {
            red: new Uint16Array(256),
            green: new Uint16Array(256),
            blue: new Uint16Array(256),
        };
        for (let i = 0; i < 256; i++) {
            ramp.red[i] = (i * 257) & 0xffff;
            ramp.green[i] = ((255 - i) * 257) & 0xffff;
            ramp.blue[i] = ((i * 97) ^ 0x55aa) & 0xffff;
        }
        expect(isIdentityGammaRamp9(ramp)).toBe(false);
        expect(writeGammaRamp9(memory, 64, ramp)).toBe(true);
        const decoded = parseGammaRamp9(memory, 64);
        expect(decoded).not.toBeNull();
        expect(Array.from(decoded!.red)).toEqual(Array.from(ramp.red));
        expect(Array.from(decoded!.green)).toEqual(Array.from(ramp.green));
        expect(Array.from(decoded!.blue)).toEqual(Array.from(ramp.blue));
        expect(writeGammaRamp9(memory, 0, ramp)).toBe(false);
        expect(parseGammaRamp9(memory, 600)).toBeNull();
    });

    test("presentation state exposes front-buffer lifetime and interval", () => {
        const state = new D3D9PresentationState();
        state.createChain(0, {
            ...defaultPresentationParameters9(),
            presentationInterval: D3DPRESENT_INTERVAL_THREE,
        });
        expect(state.getChain(0)?.intervalRefreshes).toBe(3);
        expect(state.canCaptureFrontBuffer(0)).toBe(false);
        expect(state.present(0, {
            sourceRect: null,
            destRect: null,
            destWindow: 0,
            dirtyRegion: 0,
            flags: 0,
            dirtyRects: [],
        }, 1234)).toBe(0);
        expect(state.canCaptureFrontBuffer(0)).toBe(true);
        expect(state.getFrontBufferSerial(0)).toBe(1);
        expect(state.getChain(0)?.lastPresent?.dirtySummary.kind).toBe("empty");
        state.markLost();
        expect(state.canCaptureFrontBuffer(0)).toBe(false);
        expect(state.getFrontBufferSerial(0)).toBe(1);
        expect(state.reset({ ...defaultPresentationParameters9(), presentationInterval: D3DPRESENT_INTERVAL_IMMEDIATE })).toBe(0);
        expect(state.getChain(0)?.intervalRefreshes).toBe(0);
        expect(state.canCaptureFrontBuffer(0)).toBe(false);
        expect(state.getFrontBufferSerial(0)).toBe(1);
    });

    test("validates present without mutating history until commit", () => {
        const state = new D3D9PresentationState();
        state.createChain(0, defaultPresentationParameters9());
        const request = {
            sourceRect: null,
            destRect: null,
            destWindow: 0,
            dirtyRegion: 0,
            flags: 0,
        };
        expect(state.validatePresent(0, request)).toBe(0);
        expect(state.getChain(0)?.presents).toBe(0);
        expect(state.getChain(0)?.frontBufferValid).toBe(false);
        expect(state.present(0, request)).toBe(0);
        expect(state.getChain(0)?.presents).toBe(1);
        state.markLost();
        expect(state.validatePresent(0, request)).toBe(0x88760868);
        expect(state.getChain(0)?.presents).toBe(1);
    });

    test("allows multisampling only on a DISCARD (or FLIPEX) chain", () => {
        const base = defaultPresentationParameters9();
        expect(validatePresentationParameters9({
            ...base, swapEffect: D3DSWAPEFFECT_COPY, multiSampleType: 4,
        }, false)).toBe(0x8876086c);
        expect(validatePresentationParameters9({
            ...base, swapEffect: D3DSWAPEFFECT_FLIP, multiSampleType: 2,
        }, false)).toBe(0x8876086c);
        expect(validatePresentationParameters9({
            ...base, swapEffect: D3DSWAPEFFECT_DISCARD, multiSampleType: 4,
        }, false)).toBe(0);
        expect(validatePresentationParameters9({
            ...base, swapEffect: D3DSWAPEFFECT_FLIPEX, multiSampleType: 4,
        }, true)).toBe(0);
        // A non-multisampled COPY chain stays legal.
        expect(validatePresentationParameters9({
            ...base, swapEffect: D3DSWAPEFFECT_COPY,
        }, false)).toBe(0);
    });

    test("accepts Present rectangles only on a COPY chain", () => {
        const rect = { left: 0, top: 0, right: 8, bottom: 8 };
        const request = { sourceRect: rect, destRect: null, destWindow: 0, dirtyRegion: 0, flags: 0 };
        const discard = new D3D9PresentationState();
        discard.createChain(0, defaultPresentationParameters9());
        expect(discard.validatePresent(0, request)).toBe(0x8876086c);
        expect(discard.present(0, request)).toBe(0x8876086c);
        expect(discard.getChain(0)?.presents).toBe(0);
        expect(discard.validatePresent(0, { ...request, sourceRect: null })).toBe(0);
        expect(discard.validatePresent(0, { ...request, sourceRect: null, destRect: rect })).toBe(0x8876086c);

        const copy = new D3D9PresentationState();
        copy.createChain(0, { ...defaultPresentationParameters9(), swapEffect: D3DSWAPEFFECT_COPY });
        expect(copy.validatePresent(0, request)).toBe(0);
        expect(copy.present(0, { ...request, destRect: rect })).toBe(0);
    });
});
