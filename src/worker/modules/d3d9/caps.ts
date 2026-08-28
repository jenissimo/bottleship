import { Mem } from '../../core/memory/mem-accessor';
import {
    D3DFMT_A8R8G8B8,
    d3d9VolumeTextureCapsBits,
    getD3D9VolumeCapabilityContract,
    resolveD3D9VolumePolicy,
} from '../../backends/webgpu/shared/volume-policy';
import { getD3D9WebGpuCapabilityLimits } from '../../backends/webgpu/shared/webgpu-capability-limits';
import { supportsShaderPredication } from '../../backends/webgpu/d3d9/shader/sm-parser';

const D3DCAPS9_SIZE = 304;

// ============================================================================
// Reference D3DCAPS9 captured from real Windows hardware via demos/demo_caps_dump9
// (IDirect3DDevice9::GetDeviceCaps on a created HAL device, software vertex
// processing). NVIDIA GeForce RTX 3090, D3D9-on-D3D12. These are a valid
// superset — "make our device look capable enough". Hand-authored zeros/wrong
// fields (Caps2/Caps3/DevCaps2=0, PrimitiveMiscCaps=0xCF, VS/PS shader caps
// zero) make strict consumers (e.g. in-EXE D3DX9 effect compiler) take a
// "graceful unsupported" branch. Match real hardware field-for-field.
//
// Byte-exact dump (304 bytes, little-endian struct layout from d3d9types.h);
// regenerate with demos/demo_caps_dump9 + tools.
// ============================================================================
const REAL_CAPS9_HEX =
    '010000000000000000000200000002e0a00300000f00008001000000f0be1b00' +
    'f2ce2f0091217307ff000000ff3f0000ff3f0000ff00000008420800c5ec0100' +
    '0007030300030303000303033f0000003f0000001f0000000040000000400000' +
    '00080000002000000040000010000000f902155020bcbecc20bcbecc20bcbe4c' +
    '20bcbe4c00000000ff01000008001800fffffe0308000000080000007b010000' +
    'ff0000000600000004000000ff00000000000046ffffff00ffffff0010000000' +
    'ff0000000003feff002000000003ffff00e07f47510000000000000000000000' +
    '000000000000000001000000ff03000004000000000300030100000018000000' +
    '20000000040000001f00000018000000200000000400000000020000001b031b' +
    'ffffffffffff00000080000000100000';

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

const REAL_CAPS9 = hexToBytes(REAL_CAPS9_HEX);
const BASE_CAPS9_MAX_TEXTURE_WIDTH = new DataView(REAL_CAPS9.buffer).getUint32(88, true);
const BASE_CAPS9_MAX_TEXTURE_HEIGHT = new DataView(REAL_CAPS9.buffer).getUint32(92, true);
const BASE_CAPS9_MAX_TEXTURE_ASPECT_RATIO = new DataView(REAL_CAPS9.buffer).getUint32(104, true);

const VS_FLOAT_REGISTER_COUNT = 256;
const PS_DYNAMIC_FLOW_CONTROL_DEPTH = 24;
const PS_STATIC_FLOW_CONTROL_DEPTH = 4;
const D3DPS20CAPS_PREDICATION = 0x00000004;
// WGSL derivatives are legal only in uniform control flow in this backend.  The
// linker deliberately refuses DSX/DSY/TEXLDD in divergent flow, so advertising
// the global D3D9 gradient-instruction bit would let a title select an unsafe
// shader path and lose the draw instead of taking its fallback.
const D3DPS20CAPS_GRADIENTINSTRUCTIONS = 0x00000002;
const D3DPMISCCAPS_MRTINDEPENDENTBITDEPTHS = 0x00040000;
// D3DPTADDRESSCAPS. WebGPU has native equivalents for WRAP, MIRROR and CLAMP;
// BORDER and MIRRORONCE are lowered around the generated texture sample with
// clamped coordinates and an explicit border selection.
const D3DPTADDRESSCAPS_BORDER = 0x00000008;
const D3DPTADDRESSCAPS_MIRRORONCE = 0x00000020;
// D3DCAPS9.StencilCaps (offset 136). The default and D24S8 depth paths use WebGPU's
// depth24plus-stencil8 attachment and lower all D3D9 stencil operations, including two-sided
// mode. Keep the mask explicit rather than inheriting a larger native-adapter claim.
const D3D9_STENCIL_CAPS_OFFSET = 136;
const D3DSTENCILCAPS_ALL = 0x000001ff;
const D3DTEXOPCAPS_BUMPENVMAP = 0x00200000;
const D3DTEXOPCAPS_BUMPENVMAPLUMINANCE = 0x00400000;
const D3DCAPS2_CANAUTOGENMIPMAP = 0x40000000;
const D3DPRASTERCAPS_DITHER = 0x00000004;
const D3DDTCAPS_UNSUPPORTED = 0x000000c0; // UDEC3 | DEC3N
const CONSERVATIVE_MAX_TEXTURE_DIMENSION_2D = 4096;

// ── Capability hygiene: patch the raw RTX dump to the implementation's contract
// relative to what our WGSL FFP actually implements. Patch them to OUR true capability
// so a strict consumer doesn't take a path we can't honor. Applied once to the shared
// blob (offsets from the D3DCAPS9 layout in d3d9types.h, little-endian):
//   - MaxActiveLights (off 160): dump says 255; our shared FFP lighting caps at
//     FFP_MAX_LIGHTS = 8 (ffp-lighting.ts). A game enabling >8 simultaneous lights would
//     otherwise get only the first 8 with no cap signal. D3D8/D3D7 already honestly say 8.
//   - VertexProcessingCaps (off 156): retain D3DVTXPCAPS_TWEENING (0x40); declaration-based
//     POSITION0/POSITION1 + NORMAL0/NORMAL1 morphing is lowered by the FFP vertex shader.
//   - MaxVertexBlendMatrices/MaxVertexBlendMatrixIndex (off 168/172): the FFP input layout and
//     uniforms expose four non-indexed matrices and an eight-entry indexed world palette. The
//     draw resolver still refuses malformed declarations rather than applying WORLD once.
//   - VertexTextureFilterCaps (off 284): W16 carries independent live texture/sampler state for
//     stages 257..260 through draw snapshots and vertex-visible WebGPU bindings. The advertised
//     mask is the point/linear subset the sampler actually lowers (set below).
//   - MaxVertexShaderConst (off 200): the dump's 8192 is a software-vertex-processing
//     number. This backend stores c0-c255; advertising the larger file makes writes above
//     c255 disappear and turns a capability probe into corrupted geometry. Keeping 256
//     preserves every currently implemented register while making titles that need more
//     choose their existing fallback path.
//   - PS20Caps/flow depths (off 264/268/276): W3's structured flow lowerer and W14's
//     predicate lowering are implemented for both stages, so retain predication and pin
//     the advertised dynamic/static depths to those implementation limits.
//   - PrimitiveMiscCaps (off 32): retain INDEPENDENTWRITEMASKS, MRTPOSTPIXELSHADERBLENDING,
//     and PERSTAGECONSTANT now that all four target descriptors carry the shared blend equation,
//     their own COLORWRITEENABLE state, and the FFP uniform uploads D3DTSS_CONSTANT per stage.
//     Clear only MRTINDEPENDENTBITDEPTHS because the backend deliberately requires every bound
//     MRT to use the same format.
//   - TextureAddressCaps (off 76): retain BORDER and MIRRORONCE because both programmable
//     and fixed-function shader emitters lower these modes explicitly.
{
    const dv = new DataView(REAL_CAPS9.buffer, REAL_CAPS9.byteOffset, REAL_CAPS9.byteLength);
    dv.setUint32(160, 8, true); // MaxActiveLights: match FFP_MAX_LIGHTS
    const vpCaps = dv.getUint32(156, true);
    dv.setUint32(156, vpCaps | 0x00000040, true); // D3DVTXPCAPS_TWEENING
    dv.setUint32(168, 4, true); // MaxVertexBlendMatrices: D3DVBF_3WEIGHTS = four matrices
    dv.setUint32(172, 7, true); // MaxVertexBlendMatrixIndex: D3DTS_WORLDMATRIX(0..7)
    dv.setUint32(200, VS_FLOAT_REGISTER_COUNT, true); // MaxVertexShaderConst: c0-c255
    const ps20Caps = dv.getUint32(264, true);
    const advertisedPs20Caps = supportsShaderPredication(2)
        ? ps20Caps | D3DPS20CAPS_PREDICATION
        : ps20Caps & ~D3DPS20CAPS_PREDICATION;
    dv.setUint32(264, advertisedPs20Caps & ~D3DPS20CAPS_GRADIENTINSTRUCTIONS, true);
    dv.setInt32(268, PS_DYNAMIC_FLOW_CONTROL_DEPTH, true); // PS20 dynamic flow depth: W3
    dv.setInt32(276, PS_STATIC_FLOW_CONTROL_DEPTH, true); // PS20 static flow depth: W3
    dv.setUint32(32, dv.getUint32(32, true) & ~D3DPMISCCAPS_MRTINDEPENDENTBITDEPTHS, true);
    const addressCaps = dv.getUint32(76, true);
    dv.setUint32(76, addressCaps | D3DPTADDRESSCAPS_BORDER | D3DPTADDRESSCAPS_MIRRORONCE, true);
    dv.setUint32(D3D9_STENCIL_CAPS_OFFSET, D3DSTENCILCAPS_ALL, true);
    dv.setUint32(144, dv.getUint32(144, true) &
        ~(D3DTEXOPCAPS_BUMPENVMAP | D3DTEXOPCAPS_BUMPENVMAPLUMINANCE), true);
    // The fixed-function combiner has no bump-env coordinate plumbing.
    // DeclTypes must not invite the two packed 10:10:10 formats that the
    // declaration resolver deliberately refuses.
    dv.setUint32(236, dv.getUint32(236, true) & ~D3DDTCAPS_UNSUPPORTED, true);
    dv.setUint32(36, dv.getUint32(36, true) & ~D3DPRASTERCAPS_DITHER, true);
    // Autogen is implemented only for a narrow format subset while the format
    // probe conservatively returns D3DOK_NOAUTOGEN. Do not advertise the broad
    // Caps2 claim until those two paths share one capability contract.
    dv.setUint32(12, dv.getUint32(12, true) & ~D3DCAPS2_CANAUTOGENMIPMAP, true);
    // The sampler lowers only point/linear/aniso. Keep the vertex-texture
    // filter mask at the subset with matching semantics (DXVK's mask).
    dv.setUint32(284, 0x03000300, true);
    // The adapter dump carries an effectively unbounded guard band; our clip
    // path is the ordinary D3D9 16-bit guard band used by the other HLE APIs.
    dv.setFloat32(116, -32768, true);
    dv.setFloat32(120, -32768, true);
    dv.setFloat32(124, 32768, true);
    dv.setFloat32(128, 32768, true);
    // Volume textures expose their COM/LockBox/CPU-copy contract, but public 3-D sampling
    // caps stay clear until a live adapter probe validates upload and device-loss recovery.
    dv.setUint32(60, dv.getUint32(60, true) & ~0x0000A000, true);
    dv.setUint32(72, 0, true);  // VolumeTextureFilterCaps
    dv.setUint32(80, 0, true);  // VolumeTextureAddressCaps
    dv.setUint32(96, 0, true);  // MaxVolumeExtent
}

export function writeDeviceCaps9(pCaps: number): boolean {
    if (REAL_CAPS9.length !== D3DCAPS9_SIZE) {
        throw new Error(`D3DCAPS9 blob is ${REAL_CAPS9.length} bytes, expected ${D3DCAPS9_SIZE}`);
    }
    // Volume support is an explicit host opt-in, just like D3D9 MSAA.  Keep the
    // default blob NONE-only, but make GetDeviceCaps agree with CheckDeviceFormat
    // when the host has proved the texture_3d path for the canonical RGBA8 format.
    // Re-clear the fields on every call so a test/runtime that removes a contract
    // cannot retain stale capability bits from an earlier query.
    const dv = new DataView(REAL_CAPS9.buffer, REAL_CAPS9.byteOffset, REAL_CAPS9.byteLength);
    const limits = getD3D9WebGpuCapabilityLimits();
    const maxTextureDimension2D = Math.min(
        BASE_CAPS9_MAX_TEXTURE_WIDTH,
        BASE_CAPS9_MAX_TEXTURE_HEIGHT,
        limits?.maxTextureDimension2D ?? CONSERVATIVE_MAX_TEXTURE_DIMENSION_2D,
    );
    // MaxTextureAspectRatio is a ratio, but it cannot exceed the largest
    // texture dimension this backend can create. Keep the pre-device answer
    // conservative and tighten it to the live device once one exists.
    const maxTextureAspectRatio = Math.min(BASE_CAPS9_MAX_TEXTURE_ASPECT_RATIO, maxTextureDimension2D);
    dv.setUint32(88, maxTextureDimension2D, true);
    dv.setUint32(92, maxTextureDimension2D, true);
    dv.setUint32(104, maxTextureAspectRatio, true);
    const textureCaps = dv.getUint32(60, true) & ~0x0000A000;
    dv.setUint32(60, textureCaps, true);
    dv.setUint32(72, 0, true);
    dv.setUint32(80, 0, true);
    dv.setUint32(96, 0, true);
    const contract = getD3D9VolumeCapabilityContract();
    const policy = contract ? resolveD3D9VolumePolicy(9, D3DFMT_A8R8G8B8) : null;
    if (policy?.supported && contract) {
        dv.setUint32(60, textureCaps | d3d9VolumeTextureCapsBits(policy), true);
        dv.setUint32(72, policy.filterCaps, true);
        dv.setUint32(80, policy.addressCaps, true);
        dv.setUint32(96, policy.maxExtent, true);
    }
    return Mem.writeBytes(pCaps, REAL_CAPS9) === D3DCAPS9_SIZE;
}
