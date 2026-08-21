import { Mem } from '../../core/memory/mem-accessor';

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

// ── Capability hygiene: the raw RTX dump over-advertises two FFP-lighting fields
// relative to what our WGSL FFP actually implements. Patch them to OUR true capability
// so a strict consumer doesn't take a path we can't honor. Applied once to the shared
// blob (offsets from the D3DCAPS9 layout in d3d9types.h, little-endian):
//   - MaxActiveLights (off 160): dump says 255; our shared FFP lighting caps at
//     FFP_MAX_LIGHTS = 8 (ffp-lighting.ts). A game enabling >8 simultaneous lights would
//     otherwise get only the first 8 with no cap signal. D3D8/D3D7 already honestly say 8.
//   - VertexProcessingCaps (off 156): clear D3DVTXPCAPS_TWEENING (0x40). We don't implement
//     morph-target tweening (no D3DRS_TWEENFACTOR consumer); advertising it invites a
//     tween path that silently does nothing. D3D8 already omits this bit.
//   - VertexTextureFilterCaps (off 284): dump says 0x1B031B00; our vertex-shader codegen
//     (shader/vs-codegen.ts) emits no texture sampling at all, and CheckDeviceFormat refuses
//     D3DUSAGE_QUERY_VERTEXTEXTURE. A non-zero filter cap here is the OTHER half of that
//     answer, so leaving it set makes the two disagree. vs_3_0 without vertex textures is a
//     shipped hardware configuration (ATI X1000), so engines have the fallback.
{
    const dv = new DataView(REAL_CAPS9.buffer, REAL_CAPS9.byteOffset, REAL_CAPS9.byteLength);
    dv.setUint32(160, 8, true); // MaxActiveLights: match FFP_MAX_LIGHTS
    const vpCaps = dv.getUint32(156, true);
    dv.setUint32(156, vpCaps & ~0x00000040, true); // clear D3DVTXPCAPS_TWEENING
    dv.setUint32(284, 0, true); // VertexTextureFilterCaps: no vertex-texture sampling
    // Volume textures: CreateVolumeTexture has no implementation, so clear VOLUMEMAP (0x2000)
    // and MIPVOLUMEMAP (0x8000) from TextureCaps and zero the volume filter/address/extent
    // fields. Advertising them makes an engine commit to a 3D-texture path (volumetric fog,
    // 3D lookup tables) that cannot be created — a mechanism it has a documented fallback for.
    dv.setUint32(60, dv.getUint32(60, true) & ~0x0000A000, true);
    dv.setUint32(72, 0, true);  // VolumeTextureFilterCaps
    dv.setUint32(80, 0, true);  // VolumeTextureAddressCaps
    dv.setUint32(96, 0, true);  // MaxVolumeExtent
}

export function writeDeviceCaps9(pCaps: number): boolean {
    if (REAL_CAPS9.length !== D3DCAPS9_SIZE) {
        throw new Error(`D3DCAPS9 blob is ${REAL_CAPS9.length} bytes, expected ${D3DCAPS9_SIZE}`);
    }
    return Mem.writeBytes(pCaps, REAL_CAPS9) === D3DCAPS9_SIZE;
}
