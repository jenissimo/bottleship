import { describe, expect, test } from "bun:test";
import {
    D3DMULTISAMPLE_2_SAMPLES,
    D3DMULTISAMPLE_4_SAMPLES,
    D3DMULTISAMPLE_NONE,
    D3DMULTISAMPLE_NONMASKABLE,
    normalizePortableWebGpuSampleCount,
    resolveDxMsaaPolicy,
} from "../../src/worker/backends/webgpu/shared/msaa-policy";
import { isDxMultiSampleTypeSupported } from "../../src/worker/backends/webgpu/shared/dx-format-support";

describe("D3D multisample policy", () => {
    test("D3D9 NONE exposes one quality and one-sample attachments", () => {
        const policy = resolveDxMsaaPolicy(9, D3DMULTISAMPLE_NONE);
        expect(policy).toEqual({
            version: 9,
            requestedType: 0,
            requestedSampleCount: 1,
            sampleCount: 1,
            qualityLevels: 1,
            supported: true,
            needsResolve: false,
            reason: null,
        });
        expect(isDxMultiSampleTypeSupported(9, D3DMULTISAMPLE_NONE)).toBe(true);
    });

    test("D3D9 nonmaskable is one sample, not a refusal", () => {
        // DXVK reaches this arithmetically: sampleCount = max(MultiSampleType, 1), and a
        // one-sample attachment is always available, so the query succeeds.
        const policy = resolveDxMsaaPolicy(9, D3DMULTISAMPLE_NONMASKABLE);
        expect(policy.supported).toBe(true);
        expect(policy.sampleCount).toBe(1);
        expect(policy.qualityLevels).toBe(1);
        expect(policy.needsResolve).toBe(false);
        expect(policy.reason).toBeNull();
        expect(isDxMultiSampleTypeSupported(9, D3DMULTISAMPLE_NONMASKABLE)).toBe(true);
    });

    test("D3D9 fixed-count requests refuse without a fake GPU plan", () => {
        for (const sampleType of [D3DMULTISAMPLE_2_SAMPLES, D3DMULTISAMPLE_4_SAMPLES]) {
            const policy = resolveDxMsaaPolicy(9, sampleType);
            expect(policy.supported).toBe(false);
            expect(policy.qualityLevels).toBe(0);
            expect(policy.sampleCount).toBe(1);
            expect(policy.needsResolve).toBe(false);
            expect(policy.reason).toContain("single-sample");
            expect(isDxMultiSampleTypeSupported(9, sampleType)).toBe(false);
        }
    });

    test("D3D8 only exposes the portable 4x color/depth resolve seam", () => {
        const two = resolveDxMsaaPolicy(8, D3DMULTISAMPLE_2_SAMPLES);
        expect(two.supported).toBe(false);
        expect(two.sampleCount).toBe(1);
        expect(two.needsResolve).toBe(false);

        const four = resolveDxMsaaPolicy(8, D3DMULTISAMPLE_4_SAMPLES);
        expect(four.supported).toBe(true);
        expect(four.sampleCount).toBe(4);
        expect(four.qualityLevels).toBe(1);
        expect(four.needsResolve).toBe(true);
    });

    test("unknown types are rejected and cannot leak a sample count", () => {
        const policy = resolveDxMsaaPolicy(9, 16);
        expect(policy.supported).toBe(false);
        expect(policy.requestedSampleCount).toBe(0);
        expect(policy.sampleCount).toBe(1);
        expect(policy.reason).toEqual(expect.any(String));
    });

    test("the shared D3D8 executor seam never forwards a two-sample preference", () => {
        expect(normalizePortableWebGpuSampleCount(2)).toBe(1);
        expect(normalizePortableWebGpuSampleCount(4)).toBe(4);
        expect(normalizePortableWebGpuSampleCount(0)).toBe(1);
    });
});
