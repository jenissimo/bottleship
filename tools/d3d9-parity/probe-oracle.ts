/**
 * D3D9 parity probes.
 *
 * A capability table is useful for finding holes, but it is not an oracle by
 * itself: a table can silently drift away from the code that answers the
 * query.  This registry keeps a small, deterministic input vector beside the
 * operation it exercises.  The local result is checked in as a fixture and
 * can also be compared with a capture produced by native D3D9 or DXVK.
 *
 * Native captures are deliberately not synthesized here.  On a host without
 * Windows/DXVK the manifest reports the capture as pending and gives the
 * exact command/shape needed to add evidence later.
 */

import {
    checkDxDeviceFormat,
} from "../../src/worker/backends/webgpu/shared/dx-format-support";
import { DxSamplerCache, type SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";
import {
    decodeD3d9Sampler,
    D3DSAMP_MIPFILTER,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-sampler";
import { resolveD3D9StretchRectPolicy } from "../../src/worker/backends/webgpu/d3d9/copy-policy";
import {
    D3DMULTISAMPLE_2_SAMPLES,
    D3DMULTISAMPLE_NONE,
    resolveDxMsaaPolicy,
} from "../../src/worker/backends/webgpu/shared/msaa-policy";
import {
    buildD3D9CapabilityProfile,
    D3D9_CAPS_LAYOUT,
    D3D9_CAPS_SIZE,
} from "./caps-profile";
import { createExExports } from "../../src/worker/modules/d3d9/ex";
import { devices } from "../../src/worker/modules/d3d9/shared-state";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type D3D9ProbeTarget = "native-d3d9" | "dxvk";
export type D3D9ProbeDomain = "caps" | "format" | "msaa" | "sampler" | "resource" | "ex";
export type D3D9ProbeJson = null | boolean | number | string | D3D9ProbeJson[] |
    { [key: string]: D3D9ProbeJson };

/** The value contract shared by local and external capability captures. */
export interface D3D9CapsFieldObservation {
    name: string;
    offset: number;
    kind: "scalar" | "float" | "bitmask" | "version";
    value: number;
    advertised: boolean;
    setBits: number[];
}

export interface D3D9CapsObservation {
    size: number;
    fields: D3D9CapsFieldObservation[];
}

/** Common result shape for CheckDeviceFormat and CheckDeviceMultiSampleType. */
export interface D3D9SupportObservation {
    supported: boolean;
    qualityLevels: number;
}

export interface D3D9ProbeDefinition {
    id: string;
    domain: D3D9ProbeDomain;
    operation: string;
    /** JSON-safe input, suitable for recording in a native/DXVK runner. */
    input: { [key: string]: D3D9ProbeJson };
    /** The local oracle is always run in CI. External targets are optional evidence. */
    externalTargets: readonly D3D9ProbeTarget[];
    owner: string;
    evidence: readonly string[];
    /** An actionable command, not a claim that a capture exists. */
    captureCommand: string;
    gap: string;
}

export interface D3D9ProbeResult extends D3D9ProbeDefinition {
    schema: 1;
    localExpected: D3D9ProbeJson;
    /** "uncovered" is reachable: a definition with no evaluator produces it. */
    localStatus: "covered" | "uncovered";
    /** Derived from the checked-in captures, never stamped. */
    externalStatus: "awaiting-capture" | "partially-captured" | "captured";
    capturedTargets: readonly D3D9ProbeTarget[];
}

export interface D3D9ProbeManifest {
    schema: 1;
    oracle: "d3d9-parity-v1";
    captureSchema: 1;
    probes: D3D9ProbeResult[];
    counts: {
        total: number;
        localCovered: number;
        awaitingCapture: number;
        nativePending: number;
        dxvkPending: number;
    };
}

const D3DDEVTYPE_HAL = 1;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_R5G6B5 = 23;
const D3DFMT_R16F = 111;
const D3DFMT_G16R16F = 112;
const D3DFMT_A16B16G16R16F = 113;
const D3DRTYPE_TEXTURE = 3;
const D3DUSAGE_RENDERTARGET = 0x00000001;

const samplerBorder: SamplerSpec = {
    min: "linear",
    mag: "linear",
    mip: "linear",
    mipNone: false,
    addressU: "d3d9-border",
    addressV: "d3d9-mirror-once",
    addressW: "clamp-to-edge",
    gameAnisotropy: 4,
    maxMipLevel: 2,
    borderColor: 0x80402010,
    mipLodBiasBits: 0x3f800000,
};

const commonCapture = "bun tools/d3d9-parity/compare-capture.ts <capture.json> (native: dotnet run --project tools/d3d9-parity/native-probe/NativeD3D9Probe.csproj -- > <capture.json>)";

/**
 * These are intentionally small seam probes.  A new unsupported path should
 * add a vector here before changing a public cap or HRESULT contract.
 */
export const D3D9_PROBE_DEFINITIONS: readonly D3D9ProbeDefinition[] = [
    {
        id: "caps-layout-and-evidence",
        domain: "caps",
        operation: "writeDeviceCaps9",
        input: { size: 304, layout: "D3DCAPS9" },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP0/FP17",
        evidence: ["tools/d3d9-parity/caps-profile.ts", "tools/tests/d3d9-capability-profile.test.ts"],
        captureCommand: commonCapture,
        gap: "Reference-only non-zero caps still need native and DXVK captures; zero refusals must remain explicit.",
    },
    {
        id: "caps-volume-filter-refusal",
        domain: "caps",
        operation: "writeDeviceCaps9.VolumeTextureFilterCaps",
        input: { size: 304, field: "VolumeTextureFilterCaps", expectedValue: 0 },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["tools/d3d9-parity/caps-profile.ts:VolumeTextureFilterCaps-refusal", "tools/tests/d3d9-capability-profile.test.ts"],
        captureCommand: commonCapture,
        gap: "Volume filtering remains deliberately advertised as zero until a live 3-D WebGPU capability contract and image conformance path exist; native/DXVK caps extraction records the intentional divergence.",
    },
    {
        id: "check-device-format-cross-bpp",
        domain: "format",
        operation: "CheckDeviceFormat",
        input: {
            version: 9, adapterFormat: D3DFMT_R5G6B5, usage: 0,
            resourceType: D3DRTYPE_TEXTURE, format: D3DFMT_A8R8G8B8,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/backends/webgpu/shared/dx-format-support.ts", "tools/tests/dx-format-support.test.ts"],
        captureCommand: commonCapture,
        gap: "The cross-bpp adapter matrix is based on documented/observed D3D9 behavior but has no checked-in native/DXVK capture.",
    },
    {
        id: "check-device-format-unsupported-float-rt",
        domain: "format",
        operation: "CheckDeviceFormat",
        input: {
            version: 9, adapterFormat: D3DFMT_X8R8G8B8, usage: D3DUSAGE_RENDERTARGET,
            resourceType: D3DRTYPE_TEXTURE, format: D3DFMT_R16F,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/backends/webgpu/shared/dx-format-support.ts", "tools/tests/dx-format-support.test.ts"],
        captureCommand: commonCapture,
        gap: "16-bit-float render targets are intentionally refused until a faithful storage/readback path exists; verify the HRESULT against both targets.",
    },
    {
        id: "check-device-format-r16f-texture",
        domain: "format",
        operation: "CheckDeviceFormat",
        input: {
            version: 9, adapterFormat: D3DFMT_X8R8G8B8, usage: 0,
            resourceType: D3DRTYPE_TEXTURE, format: D3DFMT_R16F,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP2/FP18",
        evidence: ["src/worker/backends/webgpu/shared/float-format-policy.ts", "tools/tests/d3d9-float-policy.test.ts"],
        captureCommand: commonCapture,
        gap: "R16F sampled storage is opt-in behind a host allocation/upload/sampling/readback contract; compare the native/DXVK texture-format answer before enabling it by default.",
    },
    {
        id: "check-device-format-g16r16f-texture",
        domain: "format",
        operation: "CheckDeviceFormat",
        input: {
            version: 9, adapterFormat: D3DFMT_X8R8G8B8, usage: 0,
            resourceType: D3DRTYPE_TEXTURE, format: D3DFMT_G16R16F,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP2/FP18",
        evidence: ["src/worker/backends/webgpu/shared/float-format-policy.ts", "tools/tests/d3d9-float-policy.test.ts"],
        captureCommand: commonCapture,
        gap: "G16R16F sampled storage is opt-in behind the same four-probe host contract; compare native/DXVK format acceptance before enabling it by default.",
    },
    {
        id: "check-device-format-a16b16g16r16f-texture",
        domain: "format",
        operation: "CheckDeviceFormat",
        input: {
            version: 9, adapterFormat: D3DFMT_X8R8G8B8, usage: 0,
            resourceType: D3DRTYPE_TEXTURE, format: D3DFMT_A16B16G16R16F,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP2/FP18",
        evidence: ["src/worker/backends/webgpu/shared/float-format-policy.ts", "tools/tests/d3d9-float-policy.test.ts"],
        captureCommand: commonCapture,
        gap: "A16B16G16R16F sampled storage is opt-in behind the same four-probe host contract; compare native/DXVK format acceptance before enabling it by default.",
    },
    {
        id: "d3d9-msaa-none",
        domain: "msaa",
        operation: "CheckDeviceMultiSampleType",
        input: { version: 9, surfaceFormat: D3DFMT_X8R8G8B8, windowed: true, multiSampleType: D3DMULTISAMPLE_NONE },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/backends/webgpu/shared/msaa-policy.ts", "tools/tests/d3d9-msaa-policy.test.ts"],
        captureCommand: commonCapture,
        gap: "The single-sample D3D9 path is covered locally; external captures guard against a driver-specific quality-level drift.",
    },
    {
        id: "d3d9-msaa-2x-refusal",
        domain: "msaa",
        operation: "CheckDeviceMultiSampleType",
        input: { version: 9, surfaceFormat: D3DFMT_X8R8G8B8, windowed: true, multiSampleType: D3DMULTISAMPLE_2_SAMPLES },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/backends/webgpu/shared/msaa-policy.ts", "tools/tests/d3d9-msaa-policy.test.ts"],
        captureCommand: commonCapture,
        gap: "D3D9 2x is accepted only under an explicit host sample-capability contract; the default path remains a strict refusal and native/DXVK evidence is required before broad advertisement.",
    },
    {
        id: "sampler-border-and-mirror-once",
        domain: "sampler",
        operation: "ResolveSamplerDescriptor",
        input: {
            min: "linear", mag: "linear", mip: "linear", mipNone: false,
            addressU: "d3d9-border", addressV: "d3d9-mirror-once", addressW: "clamp-to-edge",
            gameAnisotropy: 4, maxMipLevel: 2, borderColor: 0x80402010, mipLodBiasBits: 0x3f800000,
            quality: { anisotropy: 1, forceTrilinear: false },
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/backends/webgpu/shared/dx-sampler.ts", "tools/tests/dx-sampler.test.ts"],
        captureCommand: commonCapture,
        gap: "Border and mirror-once are shader-emulated because WebGPU has no matching native sampler modes; compare observable texels on both targets.",
    },
    {
        id: "sampler-anisotropic-mip-filter",
        domain: "sampler",
        operation: "ResolveSamplerDescriptor",
        input: { mipFilter: 3, filterName: "D3DTEXF_ANISOTROPIC" },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP5/FP17",
        evidence: ["src/worker/backends/webgpu/d3d9/d3d9-sampler.ts:mip-filter", "G:/sources/dxvk/src/d3d9/d3d9_util.h:175-176", "tools/tests/d3d9-sampler.test.ts"],
        captureCommand: commonCapture,
        gap: "The local decoder now maps ANISOTROPIC mip filtering to linear mip selection like DXVK; a created-device sampler-state capture is still required, and no unavailable hardware result is synthesized.",
    },
    {
        id: "resource-stretchrect-rt-to-offscreen-stretch",
        domain: "resource",
        operation: "StretchRect",
        input: {
            source: { format: D3DFMT_A8R8G8B8, usage: D3DUSAGE_RENDERTARGET, pool: 0, width: 2, height: 2, multiSampleType: 0, texturePtr: 257 },
            destination: { format: D3DFMT_A8R8G8B8, usage: 0, pool: 0, width: 4, height: 4, multiSampleType: 0, texturePtr: 514, offscreenPlain: true },
            filter: 2,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP8/FP17",
        evidence: ["src/worker/backends/webgpu/d3d9/copy-policy.ts:offscreen-readback", "src/worker/backends/webgpu/d3d9/d3d9-device.ts:stretchRect", "tools/tests/d3d9-copy-policy.test.ts", "G:/sources/dxvk/src/d3d9/d3d9_device.cpp:1360-1364"],
        captureCommand: commonCapture,
        gap: "The single-sample local seam now performs GPU readback plus CPU scale/encode for DEFAULT offscreen-plain destinations; MSAA/depth/compressed and native/DXVK byte-level differentials still require created-resource captures.",
    },
    {
        id: "ex-convolution-invalidcall",
        domain: "ex",
        operation: "IDirect3DDevice9Ex_SetConvolutionMonoKernel",
        input: { device: 0, width: 3, height: 3, rows: null, columns: null },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/modules/d3d9/ex.ts:SetConvolutionMonoKernel-invalidcall", "tools/tests/d3d9-ex-lifecycle.test.ts", "tools/d3d9-parity/native-probe/Program.cs:Ex-probes", "G:/sources/dxvk/src/d3d9/d3d9_device.cpp:4114-4121"],
        captureCommand: commonCapture,
        gap: "The unsupported Ex operation has an explicit INVALIDCALL contract; capture the native/DXVK HRESULT before changing it.",
    },
    {
        id: "ex-compose-rects-compat-stub",
        domain: "ex",
        operation: "IDirect3DDevice9Ex_ComposeRects",
        input: {
            device: 0, src: null, dst: null, srcRectDescs: null, numRects: 0,
            dstRectDescs: null, operation: "D3DCOMPOSERECTS_COPY", xOffset: 0, yOffset: 0,
        },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/modules/d3d9/ex.ts:ComposeRects-compat-stub", "tools/tests/d3d9-ex-lifecycle.test.ts", "tools/d3d9-parity/native-probe/Program.cs:Ex-probes", "G:/sources/dxvk/src/d3d9/d3d9_device.cpp:4124-4139"],
        captureCommand: commonCapture,
        gap: "ComposeRects is a compatibility stub returning success; the oracle must not mislabel this as E_NOTIMPL.",
    },
    {
        id: "ex-check-resource-residency-stub",
        domain: "ex",
        operation: "IDirect3DDevice9Ex_CheckResourceResidency",
        input: { device: "created-device", resources: null, count: 0 },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/modules/d3d9/ex.ts:CheckResourceResidency-stub", "tools/tests/d3d9-ex-lifecycle.test.ts", "tools/d3d9-parity/native-probe/Program.cs:Ex-probes", "G:/sources/dxvk/src/d3d9/d3d9_device.cpp:4175-4181"],
        captureCommand: commonCapture,
        gap: "The local Ex stub returns D3D_OK for a null resource array with count zero; the executable probe records the native invalid-input HRESULT instead of treating the stub as differential parity.",
    },
    {
        id: "ex-check-device-state-stub",
        domain: "ex",
        operation: "IDirect3DDevice9Ex_CheckDeviceState",
        input: { device: "created-device", destinationWindow: 0 },
        externalTargets: ["native-d3d9", "dxvk"],
        owner: "FP17",
        evidence: ["src/worker/modules/d3d9/ex.ts:CheckDeviceState-stub", "tools/tests/d3d9-ex-lifecycle.test.ts", "tools/d3d9-parity/native-probe/Program.cs:Ex-probes", "G:/sources/dxvk/src/d3d9/d3d9_device.cpp:4217-4223"],
        captureCommand: commonCapture,
        gap: "The local Ex stub returns D3D_OK for a valid device; the native/DXVK runner needs a created device and window-state vector, so no unavailable result is fabricated here.",
    },
];

/**
 * The Ex probes must call what the guest calls. A literal HRESULT here would compare the
 * native capture against a constant in this file rather than against our behaviour.
 * These handlers are pure over the device registry, so a scoped registration is the whole
 * environment they need.
 */
const EX_PROBE_DEVICE = 0x9e000100;

export function callD3D9ExHandler(name: string, args: number[]): number {
    const handler = createExExports()[name];
    if (!handler) throw new Error(`d3d9 Ex export ${name} has no handler`);
    const hadDevice = devices.has(EX_PROBE_DEVICE);
    // The control-plane stubs only ask "is this a live device"; nothing reads the object.
    if (!hadDevice) devices.set(EX_PROBE_DEVICE, {} as never);
    try {
        return handler({} as never, new Uint8Array(0), args) >>> 0;
    } finally {
        if (!hadDevice) devices.delete(EX_PROBE_DEVICE);
    }
}

function capsFieldsFromProfile(): D3D9CapsFieldObservation[] {
    const profile = buildD3D9CapabilityProfile();
    return profile.fields.map(field => ({
            name: field.name,
            offset: field.offset,
            kind: field.kind,
            value: field.value,
            advertised: field.advertised,
            setBits: field.setBits,
        }));
}

function capsSignature(): D3D9ProbeJson {
    return { hresult: 0, caps: { size: D3D9_CAPS_SIZE, fields: capsFieldsFromProfile() } };
}

function supportFromHresult(hresult: number): D3D9SupportObservation {
    // SUCCEEDED(hr), not hr === 0: D3DOK_NOAUTOGEN is a success status, and the native
    // runner classifies with the same predicate. Two different success tests across the
    // two sides of a differential would report drift that is only in the comparator.
    // CheckDeviceFormat has no quality-level out parameter; the zero is explicit rather
    // than omitted so native and local captures stay interchangeable.
    return { supported: (hresult | 0) >= 0, qualityLevels: 0 };
}

function evaluateProbe(id: string): D3D9ProbeJson {
    switch (id) {
        case "caps-layout-and-evidence":
            return capsSignature();
        case "caps-volume-filter-refusal": {
            const field = buildD3D9CapabilityProfile().fields.find(row => row.name === "VolumeTextureFilterCaps");
            if (!field) throw new Error("VolumeTextureFilterCaps is missing from the D3DCAPS9 profile");
            return field.value;
        }
        case "check-device-format-cross-bpp":
            return supportFromHresult(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_R5G6B5, 0, D3DRTYPE_TEXTURE, D3DFMT_A8R8G8B8)) as unknown as D3D9ProbeJson;
        case "check-device-format-unsupported-float-rt":
            return supportFromHresult(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, D3DUSAGE_RENDERTARGET, D3DRTYPE_TEXTURE, D3DFMT_R16F)) as unknown as D3D9ProbeJson;
        case "check-device-format-r16f-texture":
            return supportFromHresult(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_R16F)) as unknown as D3D9ProbeJson;
        case "check-device-format-g16r16f-texture":
            return supportFromHresult(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_G16R16F)) as unknown as D3D9ProbeJson;
        case "check-device-format-a16b16g16r16f-texture":
            return supportFromHresult(checkDxDeviceFormat(9, 0, D3DDEVTYPE_HAL, D3DFMT_X8R8G8B8, 0, D3DRTYPE_TEXTURE, D3DFMT_A16B16G16R16F)) as unknown as D3D9ProbeJson;
        case "d3d9-msaa-none":
            {
                const policy = resolveDxMsaaPolicy(9, D3DMULTISAMPLE_NONE);
                return { supported: policy.supported, qualityLevels: policy.qualityLevels };
            }
        case "d3d9-msaa-2x-refusal":
            {
                const policy = resolveDxMsaaPolicy(9, D3DMULTISAMPLE_2_SAMPLES);
                return { supported: policy.supported, qualityLevels: policy.qualityLevels };
            }
        case "sampler-border-and-mirror-once":
            return DxSamplerCache.resolveDescriptor(samplerBorder, { anisotropy: 1, forceTrilinear: false }) as unknown as D3D9ProbeJson;
        case "sampler-anisotropic-mip-filter": {
            const sampler = decodeD3d9Sampler(type => type === D3DSAMP_MIPFILTER ? 3 : 0);
            return { mip: sampler.mip, mipNone: sampler.mipNone };
        }
        case "resource-stretchrect-rt-to-offscreen-stretch":
            return resolveD3D9StretchRectPolicy(
                {
                    format: D3DFMT_A8R8G8B8, usage: D3DUSAGE_RENDERTARGET, pool: 0,
                    width: 2, height: 2, multiSampleType: 0, texturePtr: 257,
                },
                {
                    format: D3DFMT_A8R8G8B8, usage: 0, pool: 0,
                    width: 4, height: 4, multiSampleType: 0, texturePtr: 514, offscreenPlain: true,
                },
                2,
            ) as unknown as D3D9ProbeJson;
        case "ex-convolution-invalidcall":
            return callD3D9ExHandler("IDirect3DDevice9Ex_SetConvolutionMonoKernel", [EX_PROBE_DEVICE, 3, 3, 0, 0]);
        case "ex-compose-rects-compat-stub":
            return callD3D9ExHandler("IDirect3DDevice9Ex_ComposeRects", [EX_PROBE_DEVICE, 0, 0, 0, 0, 0, 1, 0, 0]);
        case "ex-check-resource-residency-stub":
            return callD3D9ExHandler("IDirect3DDevice9Ex_CheckResourceResidency", [EX_PROBE_DEVICE, 0, 0]);
        case "ex-check-device-state-stub":
            return callD3D9ExHandler("IDirect3DDevice9Ex_CheckDeviceState", [EX_PROBE_DEVICE, 0]);
        default:
            throw new Error(`unknown D3D9 parity probe ${id}`);
    }
}

export function runD3D9Probe(id: string): D3D9ProbeJson {
    return evaluateProbe(id);
}

/**
 * Probe ids covered by each checked-in capture, keyed by target.  `externalStatus` is
 * READ from this: stamping "awaiting-capture" on every row reported a capture we have as
 * missing, and made the manifest validator's localStatus/external checks unfailable.
 */
export function loadCheckedInD3D9Captures(): Map<D3D9ProbeTarget, Set<string>> {
    const covered = new Map<D3D9ProbeTarget, Set<string>>();
    const directory = fileURLToPath(new URL("./captures", import.meta.url));
    let entries: string[];
    try {
        entries = readdirSync(directory).filter(name => name.endsWith(".json")).sort();
    } catch {
        return covered;
    }
    for (const entry of entries) {
        let capture: D3D9Capture;
        try {
            capture = JSON.parse(readFileSync(`${directory}/${entry}`, "utf8")) as D3D9Capture;
        } catch {
            continue;
        }
        // A capture that fails its own schema check is not evidence of anything.
        if (validateD3D9Capture(capture).length > 0) continue;
        const target = covered.get(capture.target) ?? new Set<string>();
        for (const id of Object.keys(capture.probes)) target.add(id);
        covered.set(capture.target, target);
    }
    return covered;
}

export function buildD3D9ProbeManifest(): D3D9ProbeManifest {
    const captured = loadCheckedInD3D9Captures();
    const probes = D3D9_PROBE_DEFINITIONS.map((definition): D3D9ProbeResult => {
        // A definition with no evaluator is an uncovered row, not a covered one: this is
        // what makes the manifest validator's localStatus check able to fail.
        let localExpected: D3D9ProbeJson = null;
        let localStatus: "covered" | "uncovered" = "covered";
        try {
            localExpected = runD3D9Probe(definition.id);
        } catch {
            localStatus = "uncovered";
        }
        const capturedTargets = definition.externalTargets
            .filter(target => captured.get(target)?.has(definition.id) === true);
        const externalStatus = capturedTargets.length === 0
            ? "awaiting-capture" as const
            : capturedTargets.length === definition.externalTargets.length
                ? "captured" as const
                : "partially-captured" as const;
        return {
            schema: 1 as const,
            ...definition,
            localExpected,
            localStatus,
            externalStatus,
            capturedTargets,
        };
    });
    const pending = (target: D3D9ProbeTarget): number => probes
        .filter(probe => probe.externalTargets.includes(target) && !probe.capturedTargets.includes(target)).length;
    return {
        schema: 1,
        oracle: "d3d9-parity-v1",
        captureSchema: 1,
        probes,
        counts: {
            total: probes.length,
            localCovered: probes.filter(probe => probe.localStatus === "covered").length,
            awaitingCapture: probes.filter(probe => probe.externalStatus !== "captured").length,
            nativePending: pending("native-d3d9"),
            dxvkPending: pending("dxvk"),
        },
    };
}

export function validateD3D9ProbeManifest(manifest: D3D9ProbeManifest): string[] {
    const errors: string[] = [];
    if (manifest.schema !== 1) errors.push(`unsupported probe manifest schema ${manifest.schema}`);
    if (manifest.oracle !== "d3d9-parity-v1") errors.push(`unknown oracle ${manifest.oracle}`);
    if (manifest.captureSchema !== 1) errors.push(`unsupported capture schema ${manifest.captureSchema}`);
    const ids = new Set<string>();
    for (const probe of manifest.probes) {
        if (ids.has(probe.id)) errors.push(`duplicate probe id ${probe.id}`);
        ids.add(probe.id);
        if (probe.localStatus !== "covered") errors.push(`${probe.id} local oracle is not covered`);
        if (probe.externalTargets.length === 0) errors.push(`${probe.id} has no differential target`);
        if (new Set(probe.externalTargets).size !== probe.externalTargets.length) errors.push(`${probe.id} has duplicate differential target`);
        if (probe.externalTargets.some(target => target !== "native-d3d9" && target !== "dxvk")) {
            errors.push(`${probe.id} has an unknown differential target`);
        }
        if (probe.evidence.length === 0) errors.push(`${probe.id} has no evidence anchor`);
        if (!probe.captureCommand.includes("compare-capture.ts")) errors.push(`${probe.id} has no capture command`);
        if (!probe.gap) errors.push(`${probe.id} has no gap/action text`);
        // externalStatus is derived, so it must agree with the targets it names.
        const expectedExternal = probe.capturedTargets.length === 0
            ? "awaiting-capture"
            : probe.capturedTargets.length === probe.externalTargets.length ? "captured" : "partially-captured";
        if (probe.externalStatus !== expectedExternal) errors.push(`${probe.id} external status drift`);
        if (probe.capturedTargets.some(target => !probe.externalTargets.includes(target))) {
            errors.push(`${probe.id} names a captured target it does not differentiate against`);
        }
    }
    if (manifest.counts.total !== manifest.probes.length) errors.push("probe total count drift");
    if (manifest.counts.localCovered !== manifest.probes.filter(p => p.localStatus === "covered").length) {
        errors.push("local covered count drift");
    }
    const awaitingCapture = manifest.probes.filter(p => p.externalStatus !== "captured").length;
    if (manifest.counts.awaitingCapture !== awaitingCapture) errors.push("awaiting capture count drift");
    for (const target of ["native-d3d9", "dxvk"] as const) {
        const pending = manifest.probes
            .filter(p => p.externalTargets.includes(target) && !p.capturedTargets.includes(target)).length;
        const key = target === "native-d3d9" ? "nativePending" : "dxvkPending";
        if (manifest.counts[key] !== pending) errors.push(`${key} count drift`);
    }
    return errors;
}

export interface D3D9Capture {
    schema: 1;
    target: D3D9ProbeTarget;
    /** Human-supplied provenance; no capture is considered valid without it. */
    source: string;
    environment: string;
    probes: { [probeId: string]: D3D9ProbeJson };
}

/**
 * Decode the lossless native D3DCAPS9 capture into the same field-wise value
 * contract used by the local writer.  This intentionally uses the local
 * profile only for the public D3DCAPS9 layout metadata (name/offset/kind); the
 * values are read exclusively from the supplied bytes.
 */
export function decodeD3D9CapsRawHex(rawHex: string): D3D9CapsObservation {
    if (!/^[0-9a-fA-F]+$/.test(rawHex)) {
        throw new Error("D3DCAPS9 rawHex must contain hexadecimal digits only");
    }
    if (rawHex.length !== D3D9_CAPS_SIZE * 2) {
        throw new Error(`D3DCAPS9 rawHex has ${rawHex.length / 2} bytes; expected ${D3D9_CAPS_SIZE}`);
    }
    const bytes = new Uint8Array(D3D9_CAPS_SIZE);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(rawHex.slice(i * 2, i * 2 + 2), 16);
    const view = new DataView(bytes.buffer);
    const fields = D3D9_CAPS_LAYOUT.map(([name, offset, kind]) => {
        const value = kind === "float"
            ? view.getFloat32(offset, true)
            : view.getUint32(offset, true);
        if (!Number.isFinite(value)) throw new Error(`D3DCAPS9 field ${name} is not finite`);
        const unsigned = value >>> 0;
        const setBits = kind === "bitmask"
            ? Array.from({ length: 32 }, (_, bit) => bit).filter(bit => (unsigned & (1 << bit)) !== 0)
            : [];
        return {
            name,
            offset,
            kind,
            value,
            advertised: value !== 0,
            setBits,
        };
    });
    return { size: D3D9_CAPS_SIZE, fields };
}

/** Validate both the shape and the complete D3DCAPS9 field table. */
export function validateD3D9CapsObservation(value: unknown): string[] {
    const errors: string[] = [];
    if (!isRecord(value)) return ["D3DCAPS9 observation must be an object"];
    if (value.size !== D3D9_CAPS_SIZE) errors.push(`D3DCAPS9 observation size ${String(value.size)} != ${D3D9_CAPS_SIZE}`);
    if (!Array.isArray(value.fields)) return [...errors, "D3DCAPS9 observation fields must be an array"];
    const expected = D3D9_CAPS_LAYOUT;
    if (value.fields.length !== expected.length) {
        errors.push(`D3DCAPS9 observation has ${value.fields.length} fields; expected ${expected.length}`);
    }
    const seen = new Set<string>();
    for (let i = 0; i < value.fields.length; i++) {
        const field = value.fields[i];
        if (!isRecord(field)) {
            errors.push(`D3DCAPS9 observation field ${i} must be an object`);
            continue;
        }
        const expectedField = expected[i];
        if (!expectedField) {
            errors.push(`D3DCAPS9 observation has unexpected field ${String(field.name)}`);
            continue;
        }
        const [expectedName, expectedOffset, expectedKind] = expectedField!;
        if (field.name !== expectedName) errors.push(`D3DCAPS9 field ${i} name=${String(field.name)}; expected ${expectedName}`);
        if (field.offset !== expectedOffset) errors.push(`D3DCAPS9 field ${i} offset=${String(field.offset)}; expected ${expectedOffset}`);
        if (field.kind !== expectedKind) errors.push(`D3DCAPS9 field ${i} kind=${String(field.kind)}; expected ${expectedKind}`);
        const name = String(field.name);
        if (seen.has(name)) errors.push(`D3DCAPS9 observation repeats field ${name}`);
        seen.add(name);
        if (typeof field.value !== "number" || !Number.isFinite(field.value)) {
            errors.push(`D3DCAPS9 field ${name} has a non-finite value`);
            continue;
        }
        if (field.advertised !== (field.value !== 0)) errors.push(`D3DCAPS9 field ${name} advertised flag drift`);
        const unsigned = field.value >>> 0;
        const expectedBits = expectedKind === "bitmask"
            ? Array.from({ length: 32 }, (_, bit) => bit).filter(bit => (unsigned & (1 << bit)) !== 0)
            : [];
        if (!Array.isArray(field.setBits) || JSON.stringify(field.setBits) !== JSON.stringify(expectedBits)) {
            errors.push(`D3DCAPS9 field ${name} setBits drift`);
        }
    }
    return errors;
}

/**
 * Convert legacy native captures to the common probe value contract.  The
 * conversion is keyed by probe schema, never by capture target, so a DXVK
 * capture and a native capture are checked through exactly the same path.
 */
export function normalizeD3D9Capture(capture: D3D9Capture): D3D9Capture {
    if (!isRecord(capture) || !isRecord(capture.probes)) {
        throw new Error("capture probes must be an object before normalization");
    }
    const probes = Object.fromEntries(Object.entries(capture.probes).map(([id, value]) => [
        id,
        normalizeD3D9ProbeValue(id, value),
    ]));
    return { ...capture, probes };
}

function normalizeD3D9ProbeValue(id: string, value: D3D9ProbeJson): D3D9ProbeJson {
    if (id === "caps-layout-and-evidence" && isRecord(value)) {
        const caps = isRecord(value.caps) ? value.caps : value;
        if (typeof caps.rawHex === "string") {
            return {
                hresult: typeof value.hresult === "number" ? value.hresult : 0,
                caps: decodeD3D9CapsRawHex(caps.rawHex),
            };
        }
        return value;
    }
    if (id.startsWith("check-device-format-")) {
        if (typeof value === "number") return supportFromHresult(value);
        if (isRecord(value) && typeof value.hresult === "number") {
            return supportFromHresult(value.hresult);
        }
    }
    if (id.startsWith("d3d9-msaa-") && isRecord(value) && typeof value.hresult === "number") {
        const qualityLevels = typeof value.qualityLevels === "number" &&
            Number.isInteger(value.qualityLevels) && value.qualityLevels >= 0
            ? value.qualityLevels : 0;
        return { supported: value.hresult === 0, qualityLevels: value.hresult === 0 ? qualityLevels : 0 };
    }
    return value;
}

export interface D3D9CaptureComparison {
    valid: boolean;
    missing: string[];
    extra: string[];
    mismatches: Array<{ id: string; expected: D3D9ProbeJson; observed: D3D9ProbeJson }>;
    errors: string[];
}

export function compareD3D9Capture(
    manifest: D3D9ProbeManifest,
    capture: D3D9Capture,
): D3D9CaptureComparison {
    const errors = validateD3D9Capture(capture);
    let normalized = capture;
    try {
        normalized = normalizeD3D9Capture(capture);
    } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    const expectedById = new Map(manifest.probes.map(probe => [probe.id, probe]));
    const observed = normalized.probes && typeof normalized.probes === "object" && !Array.isArray(normalized.probes)
        ? normalized.probes : {};
    const ids = Object.keys(observed);
    const missing = manifest.probes
        .filter(probe => probe.externalTargets.includes(normalized.target) && !(probe.id in observed))
        .map(probe => probe.id);
    const extra = ids.filter(id => !expectedById.has(id));
    const mismatches = manifest.probes
        .filter(probe => probe.externalTargets.includes(normalized.target) && probe.id in observed)
        .filter(probe => !sameJson(probe.localExpected, observed[probe.id]!))
        .map(probe => ({ id: probe.id, expected: probe.localExpected, observed: observed[probe.id]! }));
    return { valid: errors.length === 0 && missing.length === 0 && extra.length === 0 && mismatches.length === 0, missing, extra, mismatches, errors };
}

export function validateD3D9Capture(capture: D3D9Capture): string[] {
    const errors: string[] = [];
    if (!isRecord(capture)) return ["capture must be an object"];
    if (capture.schema !== 1) errors.push(`unsupported capture schema ${capture.schema}`);
    if (capture.target !== "native-d3d9" && capture.target !== "dxvk") errors.push(`unsupported capture target ${capture.target}`);
    if (!capture.source) errors.push("capture source is required");
    if (!capture.environment) errors.push("capture environment is required");
    if (!capture.probes || typeof capture.probes !== "object" || Array.isArray(capture.probes)) {
        errors.push("capture probes must be an object");
    } else {
        for (const [id, value] of Object.entries(capture.probes)) {
            if (!isProbeJson(value)) errors.push(`capture probe ${id} is not JSON-safe`);
            if (id === "caps-layout-and-evidence" && isRecord(value)) {
                const caps = isRecord(value.caps) ? value.caps : value;
                if (typeof value.hresult !== "number" || !Number.isFinite(value.hresult)) {
                    errors.push(`capture probe ${id}: hresult must be a finite number`);
                }
                if (typeof caps.rawHex === "string") {
                    try {
                        decodeD3D9CapsRawHex(caps.rawHex);
                    } catch (error) {
                        errors.push(`capture probe ${id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                } else if (isRecord(value.caps)) {
                    errors.push(...validateD3D9CapsObservation(value.caps).map(error => `capture probe ${id}: ${error}`));
                } else {
                    errors.push(`capture probe ${id}: missing D3DCAPS9 caps object`);
                }
            }
            if (id.startsWith("check-device-format-") || id.startsWith("d3d9-msaa-")) {
                const legacyFormat = id.startsWith("check-device-format-") && typeof value === "number";
                const legacyMsaa = id.startsWith("d3d9-msaa-") && isRecord(value) &&
                    typeof value.hresult === "number" && typeof value.qualityLevels === "number";
                if (!legacyFormat && !legacyMsaa && (!isRecord(value) || typeof value.supported !== "boolean" ||
                    typeof value.qualityLevels !== "number" || !Number.isInteger(value.qualityLevels) || value.qualityLevels < 0)) {
                    errors.push(`capture probe ${id}: expected { supported: boolean, qualityLevels: non-negative integer }`);
                }
            }
        }
    }
    return errors;
}

function sameJson(a: D3D9ProbeJson, b: D3D9ProbeJson): boolean {
    return JSON.stringify(canonicalJson(a)) === JSON.stringify(canonicalJson(b));
}

function canonicalJson(value: D3D9ProbeJson): D3D9ProbeJson {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, canonicalJson(child)])) as D3D9ProbeJson;
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProbeJson(value: unknown): value is D3D9ProbeJson {
    if (value === null || typeof value === "boolean" || typeof value === "string") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isProbeJson);
    if (typeof value === "object") return Object.values(value as Record<string, unknown>).every(isProbeJson);
    return false;
}
