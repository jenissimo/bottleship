/**
 * FFP stage bind slots must never collide with the reserved ones.
 *
 * Stage 2's sampler sat on binding 6, which the device-global FFP clip-plane buffer also
 * claims. WebGPU rejects a BindGroupLayout with a duplicate binding index, and that single
 * rejection invalidates the pipeline, the bind group and every command buffer built from
 * them — so any frame that sampled three stages was thrown away whole and the previous frame
 * stayed on screen. The picture reads as "frames duplicate while turning", nowhere near the
 * layout that caused it, which is why this is pinned structurally.
 */
import { describe, expect, test } from "bun:test";
import { STAGE_BINDINGS, RESERVED_BINDINGS } from "../../src/worker/backends/webgpu/ddraw/shader-generator";
import { MAX_FFP_SAMPLED_STAGES } from "../../src/worker/backends/webgpu/ddraw/ffp-stages";

describe("FFP stage bindings", () => {
    test("cover every sampled stage", () => {
        expect(STAGE_BINDINGS.length).toBeGreaterThanOrEqual(MAX_FFP_SAMPLED_STAGES);
    });

    test("never reuse a reserved binding", () => {
        const reserved = new Set(RESERVED_BINDINGS);
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const [sampler, texture] = STAGE_BINDINGS[s];
            expect(reserved.has(sampler)).toBe(false);
            expect(reserved.has(texture)).toBe(false);
        }
    });

    test("are unique across stages", () => {
        const seen = new Map<number, string>();
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) {
            const [sampler, texture] = STAGE_BINDINGS[s];
            for (const [b, what] of [[sampler, "sampler"], [texture, "texture"]] as const) {
                expect(seen.has(b as number)).toBe(false);
                seen.set(b as number, `stage${s}.${what}`);
            }
        }
    });

    test("the full layout a 4-stage draw builds has no duplicate index", () => {
        // Exactly the entry set bind-group-manager assembles for sampledMask = 0b1111.
        const bindings = [0];
        for (let s = 0; s < MAX_FFP_SAMPLED_STAGES; s++) bindings.push(...STAGE_BINDINGS[s]);
        bindings.push(5, 6);
        expect(new Set(bindings).size).toBe(bindings.length);
    });
});
