/**
 * Direct3D multisample capability and WebGPU attachment policy.
 *
 * This module deliberately describes the backend's implemented attachment path,
 * rather than the set of sample counts a WebGPU adapter might support.  A D3D
 * capability query must not promise an MSAA render target until the color,
 * depth, pipeline, and resolve paths agree on the same sample count.
 */

export type DxMsaaVersion = 8 | 9;

export const D3DMULTISAMPLE_NONE = 0;
export const D3DMULTISAMPLE_NONMASKABLE = 1;
export const D3DMULTISAMPLE_2_SAMPLES = 2;
export const D3DMULTISAMPLE_4_SAMPLES = 4;

/**
 * Normalize a backend-wide MSAA preference to WebGPU's portable attachment set.
 * WebGPU render attachments accept one or four samples; a requested two-sample
 * preference is therefore refused/downgraded to single-sample rather than
 * forwarded to GPUTextureDescriptor.sampleCount.
 */
export function normalizePortableWebGpuSampleCount(requested: number): 1 | 4 {
    return requested >= D3DMULTISAMPLE_4_SAMPLES ? 4 : 1;
}

export interface DxMsaaPolicy {
    version: DxMsaaVersion;
    requestedType: number;
    /** Sample count requested by a fixed-count D3DMULTISAMPLE_TYPE. */
    requestedSampleCount: number;
    /** Sample count that an accepted WebGPU attachment must actually use. */
    sampleCount: number;
    /** Number of quality values exposed to D3D9 for this type. */
    qualityLevels: number;
    supported: boolean;
    /** True only when an accepted multisample color attachment needs a resolve. */
    needsResolve: boolean;
    reason: string | null;
}

const D3D9_MSAA_RESOLVE_GAP =
    "D3D9 2x/4x attachments require an explicit host adapter capability contract; default policy remains single-sample";

/**
 * Resolve a D3D multisample type to the backend capability contract.
 *
 * D3D8's adapter has a 4x color/depth manager; 2x is deliberately refused
 * because WebGPU has no portable 2-sample attachment. D3D9's attachment manager is available only after the
 * device receives an explicit host adapter probe; this pure policy remains the
 * conservative default used by CheckDeviceMultiSampleType and capability
 * enumeration. Returning sampleCount=1 for rejected requests makes it safe for
 * callers to build a plan without accidentally creating an attachment whose
 * descriptor disagrees with the accepted capability.
 */
export function resolveDxMsaaPolicy(version: DxMsaaVersion, multiSampleType: number): DxMsaaPolicy {
    const requestedType = multiSampleType >>> 0;
    const requestedSampleCount =
        requestedType === D3DMULTISAMPLE_2_SAMPLES || requestedType === D3DMULTISAMPLE_4_SAMPLES
            ? requestedType
            : requestedType === D3DMULTISAMPLE_NONE || requestedType === D3DMULTISAMPLE_NONMASKABLE
                ? 1
                : 0;

    // NONMASKABLE asks the driver to pick a count, and every driver may pick one.
    // DXVK reaches the same answer arithmetically (sampleCount = max(type, 1)), so the
    // query succeeds with a single-sample attachment rather than reporting "no MSAA at
    // all" — which is what an engine gating its AA menu on this type would read.
    if (requestedType === D3DMULTISAMPLE_NONE || requestedType === D3DMULTISAMPLE_NONMASKABLE) {
        return {
            version,
            requestedType,
            requestedSampleCount,
            sampleCount: 1,
            qualityLevels: 1,
            supported: true,
            needsResolve: false,
            reason: null,
        };
    }

    // WebGPU's portable multisample attachment set is 1 and 4. Do not advertise
    // D3D8's legacy 2-sample enum: the old color manager created a 2-sample
    // texture, which is rejected by WebGPU and loses the whole frame.
    if (version === 8 && requestedType === D3DMULTISAMPLE_4_SAMPLES) {
        return {
            version,
            requestedType,
            requestedSampleCount,
            sampleCount: requestedSampleCount,
            qualityLevels: 1,
            supported: true,
            needsResolve: true,
            reason: null,
        };
    }

    const reason = version === 9
        ? D3D9_MSAA_RESOLVE_GAP
        : "sample count is not backed by the D3D8 WebGPU MSAA path";
    return {
        version,
        requestedType,
        requestedSampleCount,
        sampleCount: 1,
        qualityLevels: 0,
        supported: false,
        needsResolve: false,
        reason,
    };
}
