import { afterEach, describe, expect, test } from "bun:test";
import {
    checkDxDepthStencilMatch,
    checkDxDeviceFormat,
    checkDxDeviceMultiSampleType,
    getDxFormatSupportCensus,
    peekDxDepthStencilMatch,
    peekDxDeviceFormat,
    peekDxDeviceMultiSampleType,
    resetDxFormatSupportCensus,
    D3D_OK,
    D3DERR_INVALIDCALL,
    D3DERR_NOTAVAILABLE,
    type DxVersion,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import {
    getD3D9MsaaCapabilityContract,
    setD3D9MsaaCapabilityContract,
} from "../../src/worker/backends/webgpu/d3d9/multisample";

const D3DDEVTYPE_HAL = 1;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_P8 = 41;
const D3DFMT_D24S8 = 75;
const D3DFMT_DXT1 = 0x31545844;
const FOURCC_BOGUS = 0x4f474f42; // 'BOGO' — no decoder, always refused
const D3DRTYPE_SURFACE = 1;
const D3DRTYPE_TEXTURE = 3;
const D3DRTYPE_CUBETEXTURE = 5;
const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_DEPTHSTENCIL = 0x2;
const D3DUSAGE_AUTOGENMIPMAP = 0x400;

/** Every (version, usage, rType, format) combination the equivalence check sweeps. */
const FORMATS = [D3DFMT_A8R8G8B8, D3DFMT_X8R8G8B8, D3DFMT_R5G6B5, D3DFMT_P8,
    D3DFMT_D24S8, D3DFMT_DXT1, FOURCC_BOGUS, 0];
const USAGES = [0, D3DUSAGE_RENDERTARGET, D3DUSAGE_DEPTHSTENCIL, D3DUSAGE_AUTOGENMIPMAP];
const RTYPES = [D3DRTYPE_SURFACE, D3DRTYPE_TEXTURE, D3DRTYPE_CUBETEXTURE];
const VERSIONS: DxVersion[] = [8, 9];

function withMemoDisabled<T>(fn: () => T): T {
    (globalThis as { __noCapsMemo?: boolean }).__noCapsMemo = true;
    try {
        return fn();
    } finally {
        delete (globalThis as { __noCapsMemo?: boolean }).__noCapsMemo;
    }
}

afterEach(() => {
    delete (globalThis as { __noCapsMemo?: boolean }).__noCapsMemo;
    setD3D9MsaaCapabilityContract(null);
    resetDxFormatSupportCensus();
});

describe("D3D capability memo", () => {
    test("memoized answers match the uncached computation across the format matrix", () => {
        for (const version of VERSIONS) {
            for (const usage of USAGES) {
                for (const rType of RTYPES) {
                    for (const format of FORMATS) {
                        const uncached = withMemoDisabled(() => checkDxDeviceFormat(
                            version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, format));
                        // First call fills the memo, second reads it; both must agree.
                        const fresh = checkDxDeviceFormat(
                            version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, format);
                        const cached = checkDxDeviceFormat(
                            version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, format);
                        expect(fresh).toBe(uncached);
                        expect(cached).toBe(uncached);
                        expect(peekDxDeviceFormat(
                            version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, usage, rType, format)).toBe(uncached);
                    }
                }
            }
        }
    });

    test("depth-stencil match and multisample answers survive memoization", () => {
        for (const version of VERSIONS) {
            for (const rt of FORMATS) {
                for (const ds of [D3DFMT_D24S8, D3DFMT_A8R8G8B8]) {
                    const uncached = withMemoDisabled(() => checkDxDepthStencilMatch(
                        version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, rt, ds));
                    checkDxDepthStencilMatch(version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, rt, ds);
                    expect(checkDxDepthStencilMatch(
                        version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, rt, ds)).toBe(uncached);
                }
            }
            for (const type of [0, 1, 2, 4, 8]) {
                const uncached = withMemoDisabled(() => checkDxDeviceMultiSampleType(
                    version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, type));
                checkDxDeviceMultiSampleType(version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, type);
                expect(checkDxDeviceMultiSampleType(
                    version, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, type)).toBe(uncached);
            }
        }
    });

    test("a capability-contract change invalidates the cached answer", () => {
        expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4))
            .toBe(D3DERR_NOTAVAILABLE);
        expect(peekDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4))
            .toBe(D3DERR_NOTAVAILABLE);

        setD3D9MsaaCapabilityContract({ supportsSampleCount: (count: number) => count === 4 } as any);
        expect(getD3D9MsaaCapabilityContract()).not.toBe(null);
        // The setter is the invalidation seam — the stale NOTAVAILABLE must be gone.
        expect(peekDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4)).toBe(null);
        expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4)).toBe(D3D_OK);

        setD3D9MsaaCapabilityContract(null);
        expect(peekDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4)).toBe(null);
        expect(checkDxDeviceMultiSampleType(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, 4))
            .toBe(D3DERR_NOTAVAILABLE);
    });

    test("the refusal census counts calls, not distinct keys", () => {
        resetDxFormatSupportCensus();
        for (let i = 0; i < 5; i++) {
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_P8))
                .toBe(D3DERR_NOTAVAILABLE);
        }
        expect(getDxFormatSupportCensus().refusedFormat[String(D3DFMT_P8)]).toBe(5);

        // A fast-path memo hit is still a call.
        for (let i = 0; i < 3; i++) {
            expect(peekDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_P8))
                .toBe(D3DERR_NOTAVAILABLE);
        }
        expect(getDxFormatSupportCensus().refusedFormat[String(D3DFMT_P8)]).toBe(8);

        for (let i = 0; i < 4; i++) {
            checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, FOURCC_BOGUS);
        }
        expect(getDxFormatSupportCensus().refusedFourCC["0x4f474f42"]).toBe(4);
    });

    test("an accepted format is never counted as a refusal", () => {
        resetDxFormatSupportCensus();
        for (let i = 0; i < 3; i++) {
            expect(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8))
                .toBe(D3D_OK);
        }
        expect(getDxFormatSupportCensus().refusedFormat[String(D3DFMT_A8R8G8B8)]).toBeUndefined();
    });

    test("the peek entry points defer on a miss and on an invalid call", () => {
        expect(peekDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1))
            .toBe(null);
        checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1);
        expect(peekDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1))
            .toBe(D3D_OK);

        // A non-zero adapter / bogus device type is INVALIDCALL, which the peek never answers.
        expect(peekDxDeviceFormat(9, 1, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1))
            .toBe(null);
        expect(checkDxDeviceFormat(9, 1, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1))
            .toBe(D3DERR_INVALIDCALL);
        expect(peekDxDeviceFormat(9, 0, 99, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_DXT1)).toBe(null);
        expect(peekDxDepthStencilMatch(9, 1, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DFMT_A8R8G8B8, D3DFMT_D24S8))
            .toBe(null);
    });

    test("__noCapsMemo keeps every call off the memo", () => {
        checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8);
        withMemoDisabled(() => {
            expect(peekDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8))
                .toBe(null);
        });
    });
});
