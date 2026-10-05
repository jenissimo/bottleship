/**
 * Deterministic inventory of the D3DCAPS9 contract we expose.
 *
 * This is deliberately a report, not a second caps implementation.  The
 * values are read from writeDeviceCaps9(), while the evidence classifications
 * live here so a new non-zero cap cannot silently appear without an owner.
 * `reference-only` is an explicit open item: it means the value still comes
 * from the checked-in hardware reference blob and has no local implementation
 * or refusal proof yet.  It must never be interpreted as a runtime guarantee.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { writeDeviceCaps9 } from "../../src/worker/modules/d3d9/caps";

export const D3D9_CAPS_SIZE = 304;
const CAPS_PTR = 0x100;

export type D3D9CapKind = "scalar" | "float" | "bitmask" | "version";
export type D3D9CapStatus = "implemented" | "emulated" | "refused" | "reference-only";
export type D3D9CapEvidenceKind = "implementation" | "refusal" | "reference";

export interface D3D9CapFieldSpec {
    name: string;
    offset: number;
    kind: D3D9CapKind;
    status: D3D9CapStatus;
    evidenceKind: D3D9CapEvidenceKind;
    evidence: string[];
    /** Why a reference-only row is still advertised; omitted for proven rows. */
    gap?: string;
}

export interface D3D9CapField extends D3D9CapFieldSpec {
    value: number;
    advertised: boolean;
    /** Set bit positions for bitmask rows; empty for scalar/version/float rows. */
    setBits: number[];
}

export interface D3D9CapabilityProfile {
    schema: 1;
    source: "src/worker/modules/d3d9/caps.ts";
    size: number;
    fields: D3D9CapField[];
    counts: {
        fields: number;
        advertised: number;
        implemented: number;
        emulated: number;
        refused: number;
        referenceOnly: number;
        advertisedWithoutProof: number;
    };
}

type FieldTuple = readonly [name: string, offset: number, kind: D3D9CapKind];

// D3DCAPS9 layout from d3d9caps.h.  Keeping the complete layout here means
// zero-valued refusal rows are visible too, while the runtime value still
// comes from the single caps writer.
export const D3D9_CAP_LAYOUT: readonly FieldTuple[] = [
    ["DeviceType", 0, "scalar"],
    ["AdapterOrdinal", 4, "scalar"],
    ["Caps", 8, "bitmask"],
    ["Caps2", 12, "bitmask"],
    ["Caps3", 16, "bitmask"],
    ["PresentationIntervals", 20, "bitmask"],
    ["CursorCaps", 24, "bitmask"],
    ["DevCaps", 28, "bitmask"],
    ["PrimitiveMiscCaps", 32, "bitmask"],
    ["RasterCaps", 36, "bitmask"],
    ["ZCmpCaps", 40, "bitmask"],
    ["SrcBlendCaps", 44, "bitmask"],
    ["DestBlendCaps", 48, "bitmask"],
    ["AlphaCmpCaps", 52, "bitmask"],
    ["ShadeCaps", 56, "bitmask"],
    ["TextureCaps", 60, "bitmask"],
    ["TextureFilterCaps", 64, "bitmask"],
    ["CubeTextureFilterCaps", 68, "bitmask"],
    ["VolumeTextureFilterCaps", 72, "bitmask"],
    ["TextureAddressCaps", 76, "bitmask"],
    ["VolumeTextureAddressCaps", 80, "bitmask"],
    ["LineCaps", 84, "bitmask"],
    ["MaxTextureWidth", 88, "scalar"],
    ["MaxTextureHeight", 92, "scalar"],
    ["MaxVolumeExtent", 96, "scalar"],
    ["MaxTextureRepeat", 100, "scalar"],
    ["MaxTextureAspectRatio", 104, "scalar"],
    ["MaxAnisotropy", 108, "scalar"],
    ["MaxVertexW", 112, "float"],
    ["GuardBandLeft", 116, "float"],
    ["GuardBandTop", 120, "float"],
    ["GuardBandRight", 124, "float"],
    ["GuardBandBottom", 128, "float"],
    ["ExtentsAdjust", 132, "float"],
    ["StencilCaps", 136, "bitmask"],
    ["FVFCaps", 140, "bitmask"],
    ["TextureOpCaps", 144, "bitmask"],
    ["MaxTextureBlendStages", 148, "scalar"],
    ["MaxSimultaneousTextures", 152, "scalar"],
    ["VertexProcessingCaps", 156, "bitmask"],
    ["MaxActiveLights", 160, "scalar"],
    ["MaxUserClipPlanes", 164, "scalar"],
    ["MaxVertexBlendMatrices", 168, "scalar"],
    ["MaxVertexBlendMatrixIndex", 172, "scalar"],
    ["MaxPointSize", 176, "float"],
    ["MaxPrimitiveCount", 180, "scalar"],
    ["MaxVertexIndex", 184, "scalar"],
    ["MaxStreams", 188, "scalar"],
    ["MaxStreamStride", 192, "scalar"],
    ["VertexShaderVersion", 196, "version"],
    ["MaxVertexShaderConst", 200, "scalar"],
    ["PixelShaderVersion", 204, "version"],
    ["PixelShader1xMaxValue", 208, "float"],
    ["DevCaps2", 212, "bitmask"],
    ["MaxNpatchTessellationLevel", 216, "float"],
    ["Reserved5", 220, "scalar"],
    ["MasterAdapterOrdinal", 224, "scalar"],
    ["AdapterOrdinalInGroup", 228, "scalar"],
    ["NumberOfAdaptersInGroup", 232, "scalar"],
    ["DeclTypes", 236, "bitmask"],
    ["NumSimultaneousRTs", 240, "scalar"],
    ["StretchRectFilterCaps", 244, "bitmask"],
    ["VS20Caps.Caps", 248, "bitmask"],
    ["VS20Caps.DynamicFlowControlDepth", 252, "scalar"],
    ["VS20Caps.NumTemps", 256, "scalar"],
    ["VS20Caps.StaticFlowControlDepth", 260, "scalar"],
    ["PS20Caps.Caps", 264, "bitmask"],
    ["PS20Caps.DynamicFlowControlDepth", 268, "scalar"],
    ["PS20Caps.NumTemps", 272, "scalar"],
    ["PS20Caps.StaticFlowControlDepth", 276, "scalar"],
    ["PS20Caps.NumInstructionSlots", 280, "scalar"],
    ["VertexTextureFilterCaps", 284, "bitmask"],
    ["MaxVShaderInstructionsExecuted", 288, "scalar"],
    ["MaxPShaderInstructionsExecuted", 292, "scalar"],
    ["MaxVertexShader30InstructionSlots", 296, "scalar"],
    ["MaxPixelShader30InstructionSlots", 300, "scalar"],
];

/** The public layout used by the runtime profile and the raw-blob decoder. */
const CAP_LAYOUT = D3D9_CAP_LAYOUT;
export const D3D9_CAPS_LAYOUT = D3D9_CAP_LAYOUT;

type TruthClassification = readonly [status: D3D9CapStatus, evidenceKind: D3D9CapEvidenceKind];

// Independent expected values for the checked-in REAL_CAPS9_HEX reference.
// These are words rather than host-number values so float fields are checked
// bit-for-bit and bitmask fields cannot pass merely because their truthiness is
// correct.  The list is intentionally positional: a layout insertion or
// offset/type drift is reported by validateD3D9RealCapsHex().
const REAL_CAPS_WORDS: readonly number[] = [
    0x00000001, 0x00000000, 0x00020000, 0xe0020000, 0x000003a0, 0x8000000f,
    0x00000001, 0x001bbef0, 0x002fcef2, 0x07732191, 0x000000ff, 0x00003fff,
    0x00003fff, 0x000000ff, 0x00084208, 0x0001ecc5, 0x03030700, 0x03030300,
    0x03030300, 0x0000003f, 0x0000003f, 0x0000001f, 0x00004000, 0x00004000,
    0x00000800, 0x00002000, 0x00004000, 0x00000010, 0x501502f9, 0xccbebc20,
    0xccbebc20, 0x4cbebc20, 0x4cbebc20, 0x00000000, 0x000001ff, 0x00180008,
    0x03feffff, 0x00000008, 0x00000008, 0x0000017b, 0x000000ff, 0x00000006,
    0x00000004, 0x000000ff, 0x46000000, 0x00ffffff, 0x00ffffff, 0x00000010,
    0x000000ff, 0xfffe0300, 0x00002000, 0xffff0300, 0x477fe000, 0x00000051,
    0x00000000, 0x00000000, 0x00000000, 0x00000000, 0x00000001, 0x000003ff,
    0x00000004, 0x03000300, 0x00000001, 0x00000018, 0x00000020, 0x00000004,
    0x0000001f, 0x00000018, 0x00000020, 0x00000004, 0x00000200, 0x1b031b00,
    0xffffffff, 0x0000ffff, 0x00008000, 0x00001000,
];

// Expected evidence classifications are deliberately independent from
// evidenceFor().  Otherwise editing the classification map and the validator
// together could silently turn an advertised reference field into a claimed
// implementation.
const REAL_CAPS_CLASSIFICATIONS: Readonly<Record<string, TruthClassification>> = {
    DeviceType: ["implemented", "implementation"], AdapterOrdinal: ["reference-only", "reference"],
    Caps: ["reference-only", "reference"], Caps2: ["reference-only", "reference"],
    Caps3: ["reference-only", "reference"], PresentationIntervals: ["emulated", "implementation"],
    CursorCaps: ["reference-only", "reference"], DevCaps: ["reference-only", "reference"],
    PrimitiveMiscCaps: ["emulated", "implementation"], RasterCaps: ["reference-only", "reference"],
    ZCmpCaps: ["emulated", "implementation"], SrcBlendCaps: ["emulated", "implementation"],
    DestBlendCaps: ["emulated", "implementation"], AlphaCmpCaps: ["emulated", "implementation"],
    ShadeCaps: ["reference-only", "reference"], TextureCaps: ["emulated", "implementation"],
    TextureFilterCaps: ["emulated", "implementation"], CubeTextureFilterCaps: ["emulated", "implementation"],
    VolumeTextureFilterCaps: ["refused", "refusal"], TextureAddressCaps: ["emulated", "implementation"],
    VolumeTextureAddressCaps: ["refused", "refusal"], LineCaps: ["reference-only", "reference"],
    MaxTextureWidth: ["reference-only", "reference"], MaxTextureHeight: ["reference-only", "reference"],
    MaxVolumeExtent: ["refused", "refusal"], MaxTextureRepeat: ["reference-only", "reference"],
    MaxTextureAspectRatio: ["reference-only", "reference"], MaxAnisotropy: ["emulated", "implementation"],
    MaxVertexW: ["reference-only", "reference"], GuardBandLeft: ["reference-only", "reference"],
    GuardBandTop: ["reference-only", "reference"], GuardBandRight: ["reference-only", "reference"],
    GuardBandBottom: ["reference-only", "reference"], ExtentsAdjust: ["reference-only", "reference"],
    StencilCaps: ["emulated", "implementation"], FVFCaps: ["emulated", "implementation"],
    TextureOpCaps: ["emulated", "implementation"], MaxTextureBlendStages: ["implemented", "implementation"],
    MaxSimultaneousTextures: ["implemented", "implementation"], VertexProcessingCaps: ["emulated", "implementation"],
    MaxActiveLights: ["implemented", "implementation"], MaxUserClipPlanes: ["emulated", "implementation"],
    MaxVertexBlendMatrices: ["emulated", "implementation"], MaxVertexBlendMatrixIndex: ["emulated", "implementation"],
    MaxPointSize: ["reference-only", "reference"], MaxPrimitiveCount: ["reference-only", "reference"],
    MaxVertexIndex: ["reference-only", "reference"], MaxStreams: ["implemented", "implementation"],
    MaxStreamStride: ["emulated", "implementation"], VertexShaderVersion: ["emulated", "implementation"],
    MaxVertexShaderConst: ["implemented", "implementation"], PixelShaderVersion: ["emulated", "implementation"],
    PixelShader1xMaxValue: ["reference-only", "reference"], DevCaps2: ["reference-only", "reference"],
    MaxNpatchTessellationLevel: ["reference-only", "reference"], Reserved5: ["reference-only", "reference"],
    MasterAdapterOrdinal: ["reference-only", "reference"], AdapterOrdinalInGroup: ["reference-only", "reference"],
    NumberOfAdaptersInGroup: ["reference-only", "reference"], DeclTypes: ["emulated", "implementation"],
    NumSimultaneousRTs: ["emulated", "implementation"], StretchRectFilterCaps: ["reference-only", "reference"],
    "VS20Caps.Caps": ["emulated", "implementation"], "VS20Caps.DynamicFlowControlDepth": ["emulated", "implementation"],
    "VS20Caps.NumTemps": ["emulated", "implementation"], "VS20Caps.StaticFlowControlDepth": ["emulated", "implementation"],
    "PS20Caps.Caps": ["emulated", "implementation"], "PS20Caps.DynamicFlowControlDepth": ["emulated", "implementation"],
    "PS20Caps.NumTemps": ["emulated", "implementation"], "PS20Caps.StaticFlowControlDepth": ["emulated", "implementation"],
    "PS20Caps.NumInstructionSlots": ["emulated", "implementation"], VertexTextureFilterCaps: ["emulated", "implementation"],
    MaxVShaderInstructionsExecuted: ["reference-only", "reference"], MaxPShaderInstructionsExecuted: ["reference-only", "reference"],
    MaxVertexShader30InstructionSlots: ["reference-only", "reference"], MaxPixelShader30InstructionSlots: ["reference-only", "reference"],
};

// A truth-table row is not complete unless it points at a named proof or at
// the source blob that is intentionally still reference-only.  Keep these
// anchors independent from evidenceFor(): changing the runtime profile cannot
// silently manufacture proof for a raw capability word.
const REAL_CAPS_EVIDENCE_PATHS: Readonly<Record<string, string>> = {
    DeviceType: "src/worker/modules/d3d9/factory.ts:HAL-device",
    AdapterOrdinal: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    Caps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    Caps2: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    Caps3: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    PresentationIntervals: "src/worker/modules/d3d9/device.ts:Present-interval-state",
    CursorCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    DevCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    PrimitiveMiscCaps: "src/worker/backends/webgpu/d3d9/d3d9-blend.ts",
    RasterCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    ZCmpCaps: "src/worker/backends/webgpu/d3d9/d3d9-device.ts:depth-state",
    SrcBlendCaps: "src/worker/backends/webgpu/d3d9/d3d9-blend.ts",
    DestBlendCaps: "src/worker/backends/webgpu/d3d9/d3d9-blend.ts",
    AlphaCmpCaps: "src/worker/backends/webgpu/d3d9/d3d9-device.ts:alpha-test",
    ShadeCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    TextureCaps: "src/worker/backends/webgpu/shared/dx-format-support.ts",
    TextureFilterCaps: "src/worker/backends/webgpu/shared/dx-sampler.ts",
    CubeTextureFilterCaps: "src/worker/backends/webgpu/d3d9/d3d9-device.ts:cube-view",
    VolumeTextureFilterCaps: "src/worker/backends/webgpu/shared/dx-format-support.ts:volume-query-refusal",
    TextureAddressCaps: "src/worker/backends/webgpu/shared/dx-sampler.ts",
    VolumeTextureAddressCaps: "src/worker/backends/webgpu/shared/dx-format-support.ts:volume-query-refusal",
    LineCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxTextureWidth: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxTextureHeight: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxVolumeExtent: "src/worker/modules/d3d9/caps.ts:MaxVolumeExtent-zero",
    MaxTextureRepeat: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxTextureAspectRatio: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxAnisotropy: "src/worker/backends/webgpu/d3d9/d3d9-sampler.ts",
    MaxVertexW: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    GuardBandLeft: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    GuardBandTop: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    GuardBandRight: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    GuardBandBottom: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    ExtentsAdjust: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    StencilCaps: "src/worker/modules/d3d9/caps.ts:StencilCaps-depth24plus-stencil8",
    FVFCaps: "src/worker/backends/webgpu/d3d9/shader/fvf-layout.ts",
    TextureOpCaps: "src/worker/backends/webgpu/d3d9/ffp-combiner.ts",
    MaxTextureBlendStages: "src/worker/backends/webgpu/d3d9/ffp-lighting.ts",
    MaxSimultaneousTextures: "src/worker/backends/webgpu/d3d9/ffp-lighting.ts",
    VertexProcessingCaps: "src/worker/backends/webgpu/d3d9/ffp-lighting.ts",
    MaxActiveLights: "src/worker/backends/webgpu/d3d9/ffp-lighting.ts",
    MaxUserClipPlanes: "src/worker/backends/webgpu/d3d9/shader/emit/vs.ts",
    MaxVertexBlendMatrices: "src/worker/backends/webgpu/d3d9/ffp-vertex-blend.ts",
    MaxVertexBlendMatrixIndex: "src/worker/backends/webgpu/d3d9/ffp-vertex-blend.ts",
    MaxPointSize: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxPrimitiveCount: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxVertexIndex: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxStreams: "src/worker/backends/webgpu/shared/vertex-streams.ts",
    MaxStreamStride: "src/worker/backends/webgpu/shared/vertex-streams.ts",
    VertexShaderVersion: "src/worker/backends/webgpu/d3d9/shader/sm-parser.ts",
    MaxVertexShaderConst: "src/worker/backends/webgpu/d3d9/shader/emit/vs.ts",
    PixelShaderVersion: "src/worker/backends/webgpu/d3d9/shader/sm-parser.ts",
    PixelShader1xMaxValue: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    DevCaps2: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxNpatchTessellationLevel: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    Reserved5: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MasterAdapterOrdinal: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    AdapterOrdinalInGroup: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    NumberOfAdaptersInGroup: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    DeclTypes: "src/worker/backends/webgpu/d3d9/shader/fvf-layout.ts",
    NumSimultaneousRTs: "src/worker/backends/webgpu/d3d9/d3d9-device.ts:MRT",
    StretchRectFilterCaps: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    "VS20Caps.Caps": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "VS20Caps.DynamicFlowControlDepth": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "VS20Caps.NumTemps": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "VS20Caps.StaticFlowControlDepth": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "PS20Caps.Caps": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "PS20Caps.DynamicFlowControlDepth": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "PS20Caps.NumTemps": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "PS20Caps.StaticFlowControlDepth": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    "PS20Caps.NumInstructionSlots": "src/worker/backends/webgpu/d3d9/shader/passes/structure.ts",
    VertexTextureFilterCaps: "src/worker/backends/webgpu/d3d9/d3d9-device.ts:vertex-texture-window",
    MaxVShaderInstructionsExecuted: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxPShaderInstructionsExecuted: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxVertexShader30InstructionSlots: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
    MaxPixelShader30InstructionSlots: "src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX",
};

export interface D3D9RawCapsField {
    name: string;
    offset: number;
    kind: D3D9CapKind;
    wordHex: string;
    value: number;
    advertised: boolean;
    setBits: number[];
    expectedStatus: D3D9CapStatus;
    expectedEvidenceKind: D3D9CapEvidenceKind;
    evidencePath: string;
}

export interface D3D9RawCapsValidation {
    fields: D3D9RawCapsField[];
    errors: string[];
}

type Evidence = Omit<D3D9CapFieldSpec, "name" | "offset" | "kind">;

const REFUSAL_EVIDENCE: Record<string, Evidence> = {
    VolumeTextureFilterCaps: {
        status: "refused", evidenceKind: "refusal",
        evidence: ["src/worker/backends/webgpu/shared/dx-format-support.ts:volume-query-refusal", "tools/tests/d3d9-caps.test.ts:volume caps remain zero"],
        gap: "Public volume filtering caps stay zero until an adapter-backed conformance probe exists.",
    },
    VolumeTextureAddressCaps: {
        status: "refused", evidenceKind: "refusal",
        evidence: ["src/worker/backends/webgpu/shared/dx-format-support.ts:volume-query-refusal", "tools/tests/d3d9-caps.test.ts:volume caps remain zero"],
        gap: "Public volume addressing caps stay zero until an adapter-backed conformance probe exists.",
    },
    MaxVolumeExtent: {
        status: "refused", evidenceKind: "refusal",
        evidence: ["src/worker/modules/d3d9/caps.ts:MaxVolumeExtent-zero", "tools/tests/d3d9-caps.test.ts:volume caps remain zero"],
        gap: "The programmable internal 3-D path is not a public CheckDeviceFormat/caps contract.",
    },
    StencilCaps: {
        status: "emulated", evidenceKind: "implementation",
        evidence: ["src/worker/modules/d3d9/caps.ts:StencilCaps-depth24plus-stencil8", "src/worker/backends/webgpu/d3d9/d3d9-backend-executor.ts:stencil-state", "tools/tests/d3d9-caps.test.ts:stencil operations"],
    },
};

const IMPLEMENTED_EVIDENCE: Record<string, Evidence> = {
    DeviceType: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/modules/d3d9/factory.ts:HAL-device" ] },
    PresentationIntervals: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/modules/d3d9/device.ts:Present-interval-state", "tools/tests/d3d9-swapchain.test.ts"] },
    PrimitiveMiscCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-blend.ts", "tools/tests/d3d9-blend.test.ts", "tools/tests/d3d9-mrt.test.ts"] },
    ZCmpCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-device.ts:depth-state", "tools/tests/d3d9-caps.test.ts"] },
    SrcBlendCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-blend.ts", "tools/tests/d3d9-blend.test.ts"] },
    DestBlendCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-blend.ts", "tools/tests/d3d9-blend.test.ts"] },
    AlphaCmpCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-device.ts:alpha-test", "tools/tests/d3d9-blend.test.ts"] },
    TextureCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/shared/dx-format-support.ts", "tools/tests/dx-format-support.test.ts"] },
    TextureFilterCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/shared/dx-sampler.ts", "tools/tests/dx-sampler.test.ts"] },
    CubeTextureFilterCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-device.ts:cube-view", "tools/tests/d3d9-sm3-texture.test.ts"] },
    TextureAddressCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/shared/dx-sampler.ts", "tools/tests/dx-sampler.test.ts"] },
    MaxAnisotropy: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-sampler.ts", "tools/tests/d3d9-sampler.test.ts"] },
    FVFCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/fvf-layout.ts", "tools/tests/d3d9-vertex-input.test.ts"] },
    TextureOpCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-combiner.ts", "tools/tests/ffp-lighting.test.ts"] },
    MaxTextureBlendStages: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-lighting.ts", "tools/tests/ffp-lighting.test.ts"] },
    MaxSimultaneousTextures: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-lighting.ts", "tools/tests/ffp-lighting.test.ts"] },
    VertexProcessingCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-lighting.ts", "tools/tests/ffp-lighting.test.ts"] },
    MaxActiveLights: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-lighting.ts", "tools/tests/ffp-lighting.test.ts"] },
    MaxUserClipPlanes: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/emit/vs.ts", "tools/tests/d3d9-shader.test.ts"] },
    MaxVertexBlendMatrices: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-vertex-blend.ts", "tools/tests/d3d9-ffp-vertex-blend.test.ts"] },
    MaxVertexBlendMatrixIndex: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/ffp-vertex-blend.ts", "tools/tests/d3d9-ffp-vertex-blend.test.ts"] },
    MaxStreams: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/shared/vertex-streams.ts", "tools/tests/d3d9-decl-stride.test.ts"] },
    MaxStreamStride: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/shared/vertex-streams.ts", "tools/tests/d3d9-decl-stride.test.ts"] },
    VertexShaderVersion: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/sm-parser.ts", "tools/tests/d3d9-sm3-parser.test.ts"] },
    MaxVertexShaderConst: { status: "implemented", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/emit/vs.ts", "tools/tests/d3d9-caps.test.ts"] },
    PixelShaderVersion: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/sm-parser.ts", "tools/tests/d3d9-sm3-parser.test.ts"] },
    DeclTypes: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/fvf-layout.ts", "tools/tests/d3d9-declaration-buffer-desc.test.ts"] },
    NumSimultaneousRTs: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-device.ts:MRT", "tools/tests/d3d9-mrt.test.ts"] },
    VS20Caps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/passes/structure.ts", "tools/tests/d3d9-sm3-flow.test.ts"] },
    PS20Caps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/shader/passes/structure.ts", "tools/tests/d3d9-sm3-flow.test.ts", "tools/tests/d3d9-caps.test.ts"] },
    VertexTextureFilterCaps: { status: "emulated", evidenceKind: "implementation", evidence: ["src/worker/backends/webgpu/d3d9/d3d9-device.ts:vertex-texture-window", "tools/tests/d3d9-caps.test.ts"] },
};

function evidenceFor(name: string): Evidence {
    const refusal = REFUSAL_EVIDENCE[name];
    if (refusal) return refusal;
    // Nested VS20/PS20 rows share one semantic proof map.  Use the exact row
    // names in the output rather than forcing callers to understand a prefix.
    if (name.startsWith("VS20Caps.")) return IMPLEMENTED_EVIDENCE.VS20Caps!;
    if (name.startsWith("PS20Caps.")) return IMPLEMENTED_EVIDENCE.PS20Caps!;
    const implemented = IMPLEMENTED_EVIDENCE[name];
    if (implemented) return implemented;
    return {
        status: "reference-only",
        evidenceKind: "reference",
        evidence: ["src/worker/modules/d3d9/caps.ts:REAL_CAPS9_HEX"],
        gap: "Advertised by the reference blob; no deterministic local implementation/refusal proof is registered yet.",
    };
}

function readCaps9(): DataView {
    const memory = new Uint8Array(CAPS_PTR + D3D9_CAPS_SIZE + 16);
    Mem.bind(() => memory);
    if (!writeDeviceCaps9(CAPS_PTR)) throw new Error("writeDeviceCaps9 failed while building capability profile");
    return new DataView(memory.buffer, CAPS_PTR, D3D9_CAPS_SIZE);
}

function readValue(view: DataView, offset: number, kind: D3D9CapKind): number {
    if (kind === "float") return view.getFloat32(offset, true);
    return view.getUint32(offset, true);
}

function setBits(value: number, kind: D3D9CapKind): number[] {
    if (kind !== "bitmask") return [];
    const bits: number[] = [];
    const unsigned = value >>> 0;
    for (let bit = 0; bit < 32; bit++) if ((unsigned & (1 << bit)) !== 0) bits.push(bit);
    return bits;
}

function wordHex(value: number): string {
    return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Extract the checked-in source literal without importing private runtime
 * state.  Only a concatenation of hex string literals is accepted; an
 * expression, template, or second declaration is rejected as malformed
 * evidence rather than evaluated.
 */
export function extractRealCaps9Hex(source: string): string {
    const match = source.match(/const\s+REAL_CAPS9_HEX\s*=([\s\S]*?);/);
    if (!match) throw new Error("REAL_CAPS9_HEX declaration not found");
    const expression = match[1]!;
    const literals = [...expression.matchAll(/'([0-9a-fA-F]+)'/g)];
    const remainder = expression
        .replace(/'([0-9a-fA-F]+)'/g, "")
        .replace(/[+\s]/g, "");
    if (literals.length === 0 || remainder.length !== 0) {
        throw new Error("REAL_CAPS9_HEX must be a concatenation of hexadecimal string literals");
    }
    const hex = literals.map(literal => literal[1]).join("").toLowerCase();
    if (hex.length !== D3D9_CAPS_SIZE * 2 || !/^[0-9a-f]+$/.test(hex)) {
        throw new Error(`REAL_CAPS9_HEX has ${hex.length / 2} bytes; expected ${D3D9_CAPS_SIZE}`);
    }
    return hex;
}

export function readCheckedInRealCaps9Hex(): string {
    const sourcePath = fileURLToPath(new URL("../../src/worker/modules/d3d9/caps.ts", import.meta.url));
    return extractRealCaps9Hex(readFileSync(sourcePath, "utf8"));
}

function bytesFromHex(hex: string): Uint8Array {
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error("caps blob must be an even-length hexadecimal string");
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

export function decodeD3D9CapsBlob(bytes: Uint8Array): D3D9RawCapsField[] {
    if (bytes.length !== D3D9_CAPS_SIZE) {
        throw new Error(`D3DCAPS9 blob is ${bytes.length} bytes; expected ${D3D9_CAPS_SIZE}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return CAP_LAYOUT.map(([name, offset, kind]) => {
        const classification = REAL_CAPS_CLASSIFICATIONS[name];
        if (!classification) throw new Error(`missing truth-table classification for ${name}`);
        const evidencePath = REAL_CAPS_EVIDENCE_PATHS[name];
        if (!evidencePath) throw new Error(`missing truth-table evidence path for ${name}`);
        const bits = view.getUint32(offset, true);
        return {
            name,
            offset,
            kind,
            wordHex: wordHex(bits),
            value: readValue(view, offset, kind),
            advertised: bits !== 0,
            setBits: setBits(bits, kind),
            expectedStatus: classification[0],
            expectedEvidenceKind: classification[1],
            evidencePath,
        };
    });
}

/**
 * Validate the immutable reference blob, not the runtime-mutated caps output.
 * Every declared D3DCAPS9 word is checked for layout, type-aware decoding,
 * exact bits, and independent evidence classification.
 */
export function validateD3D9RealCapsHex(hex: string): D3D9RawCapsValidation {
    const errors: string[] = [];
    let fields: D3D9RawCapsField[] = [];
    let bytes: Uint8Array;
    try {
        bytes = bytesFromHex(hex);
        fields = decodeD3D9CapsBlob(bytes);
    } catch (error) {
        return { fields, errors: [error instanceof Error ? error.message : String(error)] };
    }

    if (CAP_LAYOUT.length !== D3D9_CAPS_SIZE / 4) {
        errors.push(`D3DCAPS9 layout has ${CAP_LAYOUT.length} fields; expected ${D3D9_CAPS_SIZE / 4}`);
    }
    if (REAL_CAPS_WORDS.length !== CAP_LAYOUT.length) {
        errors.push(`REAL_CAPS truth table has ${REAL_CAPS_WORDS.length} words; expected ${CAP_LAYOUT.length}`);
    }
    const names = new Set<string>();
    for (let index = 0; index < CAP_LAYOUT.length; index++) {
        const [name, offset, kind] = CAP_LAYOUT[index]!;
        const field = fields[index]!;
        if (names.has(name)) errors.push(`duplicate D3DCAPS9 field ${name}`);
        names.add(name);
        if (offset !== index * 4) errors.push(`${name} has offset ${offset}; expected ${index * 4}`);
        if (field.name !== name || field.offset !== offset || field.kind !== kind) {
            errors.push(`${name} layout decoder drift at index ${index}`);
        }
        const expectedWord = REAL_CAPS_WORDS[index];
        if (expectedWord === undefined) continue;
        if (field.wordHex !== wordHex(expectedWord)) {
            errors.push(`${name}@${offset} ${kind}: expected ${wordHex(expectedWord)}, got ${field.wordHex}`);
        }
        const classification = REAL_CAPS_CLASSIFICATIONS[name];
        if (!classification) {
            errors.push(`${name} has no independent truth-table classification`);
        } else if (field.expectedStatus !== classification[0] || field.expectedEvidenceKind !== classification[1]) {
            errors.push(`${name} truth-table classification drift`);
        }
        const evidencePath = REAL_CAPS_EVIDENCE_PATHS[name];
        if (!evidencePath || field.evidencePath !== evidencePath || evidencePath.trim().length === 0) {
            errors.push(`${name} has no named truth-table evidence path`);
        }
    }
    for (const name of Object.keys(REAL_CAPS_CLASSIFICATIONS)) {
        if (!names.has(name)) errors.push(`truth-table classification ${name} is not in D3DCAPS9 layout`);
    }
    return { fields, errors };
}

export function validateCheckedInRealCaps9(): D3D9RawCapsValidation {
    return validateD3D9RealCapsHex(readCheckedInRealCaps9Hex());
}

export function buildD3D9CapabilityProfile(): D3D9CapabilityProfile {
    const view = readCaps9();
    const fields = D3D9_CAP_LAYOUT.map(([name, offset, kind]): D3D9CapField => {
        const evidence = evidenceFor(name);
        const value = readValue(view, offset, kind);
        return {
            name, offset, kind, value,
            advertised: value !== 0,
            setBits: setBits(value, kind),
            ...evidence,
        };
    });
    const advertised = fields.filter(field => field.advertised);
    const count = (status: D3D9CapStatus): number => fields.filter(field => field.status === status).length;
    return {
        schema: 1,
        source: "src/worker/modules/d3d9/caps.ts",
        size: D3D9_CAPS_SIZE,
        fields,
        counts: {
            fields: fields.length,
            advertised: advertised.length,
            implemented: count("implemented"),
            emulated: count("emulated"),
            refused: count("refused"),
            referenceOnly: count("reference-only"),
            advertisedWithoutProof: advertised.filter(field => field.evidenceKind === "reference").length,
        },
    };
}

/**
 * How many D3DCAPS9 words we still advertise on the strength of the reference hardware
 * blob alone.  A ratchet, not a target: a new capability that arrives without an
 * implementation or refusal proof raises the count and fails the gate, and a capability
 * that gains proof must lower this number in the same change.  D3DCAPS2_CANAUTOGENMIPMAP
 * inside Caps2 is the standing item — it contradicts the D3DOK_NOAUTOGEN we answer from
 * computeDxDeviceFormat, and clearing it belongs to modules/d3d9/caps.ts.
 */
export const D3D9_ADVERTISED_WITHOUT_PROOF = 28;

/** Pure structural checks used by CI and by the generated-profile command. */
export function validateD3D9CapabilityProfile(profile: D3D9CapabilityProfile): string[] {
    const errors: string[] = [];
    if (profile.schema !== 1) errors.push(`unsupported schema ${profile.schema}`);
    if (profile.size !== D3D9_CAPS_SIZE) errors.push(`size ${profile.size} != ${D3D9_CAPS_SIZE}`);
    const seen = new Set<number>();
    const seenNames = new Set<string>();
    for (const field of profile.fields) {
        if (seen.has(field.offset)) errors.push(`duplicate offset ${field.offset}`);
        seen.add(field.offset);
        if (seenNames.has(field.name)) errors.push(`duplicate field ${field.name}`);
        seenNames.add(field.name);
        if (field.offset < 0 || field.offset + 4 > profile.size || field.offset % 4 !== 0) {
            errors.push(`${field.name} has invalid offset ${field.offset}`);
        }
        if (field.evidence.length === 0) errors.push(`${field.name} has no evidence`);
        if (field.status === "reference-only" && !field.gap) errors.push(`${field.name} reference-only row has no gap`);
        if (field.status === "refused" && field.evidenceKind !== "refusal") errors.push(`${field.name} refusal lacks refusal evidence`);
        if (field.status !== "refused" && field.evidenceKind === "refusal") errors.push(`${field.name} has refusal evidence but is not refused`);
        if (field.advertised !== (field.value !== 0)) errors.push(`${field.name} advertised flag drift`);
        // A classification is a claim about the value we actually answer with. "refused"
        // that ships a non-zero word is the claim and the caps blob disagreeing.
        if (field.status === "refused" && field.value !== 0) {
            errors.push(`${field.name} is classified refused but writeDeviceCaps9 answers ${field.value}`);
        }
        const classification = REAL_CAPS_CLASSIFICATIONS[field.name];
        if (!classification) errors.push(`${field.name} has no truth-table classification`);
        else if (field.status !== classification[0] || field.evidenceKind !== classification[1]) {
            errors.push(`${field.name} truth-table classification drift`);
        }
        if (!REAL_CAPS_EVIDENCE_PATHS[field.name]?.trim()) {
            errors.push(`${field.name} has no named truth-table evidence path`);
        }
    }
    if (seen.size !== D3D9_CAP_LAYOUT.length) errors.push(`catalog has ${seen.size}/${D3D9_CAP_LAYOUT.length} unique fields`);
    for (const name of Object.keys(REAL_CAPS_CLASSIFICATIONS)) {
        if (!seenNames.has(name)) errors.push(`truth-table classification ${name} is not in profile`);
    }
    const recounted = {
        fields: profile.fields.length,
        advertised: profile.fields.filter(field => field.advertised).length,
        implemented: profile.fields.filter(field => field.status === "implemented").length,
        emulated: profile.fields.filter(field => field.status === "emulated").length,
        refused: profile.fields.filter(field => field.status === "refused").length,
        referenceOnly: profile.fields.filter(field => field.status === "reference-only").length,
        advertisedWithoutProof: profile.fields
            .filter(field => field.advertised && field.evidenceKind === "reference").length,
    };
    for (const [key, expected] of Object.entries(recounted)) {
        const reported = profile.counts[key as keyof typeof recounted];
        if (reported !== expected) errors.push(`counts.${key} is ${reported}; fields say ${expected}`);
    }
    if (recounted.advertisedWithoutProof > D3D9_ADVERTISED_WITHOUT_PROOF) {
        errors.push(`${recounted.advertisedWithoutProof} caps advertised without proof; ` +
            `the ratchet is ${D3D9_ADVERTISED_WITHOUT_PROOF} — give the new capability an ` +
            `implementation or refusal proof, or refuse it`);
    }
    if (recounted.advertisedWithoutProof < D3D9_ADVERTISED_WITHOUT_PROOF) {
        errors.push(`${recounted.advertisedWithoutProof} caps advertised without proof; ` +
            `lower D3D9_ADVERTISED_WITHOUT_PROOF from ${D3D9_ADVERTISED_WITHOUT_PROOF} to keep the ratchet tight`);
    }
    return errors;
}
