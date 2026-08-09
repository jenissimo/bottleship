export const DD_OK = 0x00000000;
export const E_POINTER = 0x80004003;
export const E_FAIL = 0x80004005;
export const E_NOINTERFACE = 0x80004002;
export const E_INVALIDARG = 0x80070057;

// DirectDraw error codes. MAKE_DDHRESULT(n) = 0x88760000 | n; a few DDERR_* names
// are plain aliases of the COM codes in ddraw.h and must keep those exact values.
export const DDERR_NOTFOUND = 0x887600FF;
export const DDERR_OUTOFVIDEOMEMORY = 0x887600E1;
export const DDERR_INVALIDPARAMS = 0x80070057; // alias of E_INVALIDARG
export const DDERR_SURFACELOST = 0x887601C2;
export const DDERR_NOEXCLUSIVEMODE = 0x887601B6;
export const DDERR_WASSTILLDRAWING = 0x8876021C;
export const DDERR_NOCLIPPERATTACHED = 0x88760238;  // MAKE_DDHRESULT(568)
export const DDERR_NOPALETTEATTACHED = 0x8876023C;  // MAKE_DDHRESULT(572)
export const DDERR_CANTDUPLICATE = 0x88760247;      // MAKE_DDHRESULT(583)
export const DDERR_SURFACEBUSY = 0x887601AE;        // MAKE_DDHRESULT(430)
export const DDERR_NOTFLIPPABLE = 0x88760246;       // MAKE_DDHRESULT(582)

// SetCooperativeLevel flags (DDSCL_* from ddraw.h)
export const DDSCL_FULLSCREEN     = 0x00000001;
export const DDSCL_ALLOWREBOOT    = 0x00000002;
export const DDSCL_NOWINDOWCHANGES = 0x00000004;
export const DDSCL_NORMAL         = 0x00000008;
export const DDSCL_EXCLUSIVE      = 0x00000010;
export const DDSCL_ALLOWMODEX     = 0x00000040;
export const DDSCL_SETFOCUSWINDOW = 0x00000080;
export const DDSCL_SETDEVICEWINDOW = 0x00000100;
export const DDSCL_CREATEDEVICEWINDOW = 0x00000200;

// WaitForVerticalBlank flags
export const DDWAITVB_BLOCKBEGIN = 0x00000001;
export const DDWAITVB_BLOCKEND = 0x00000002;
export const DDWAITVB_BLOCKBEGINEVENT = 0x00000004;

// GetFlipStatus flags
export const DDGFS_CANFLIP = 0x00000001;
export const DDGFS_ISFLIPDONE = 0x00000002;

export const DDPF_ALPHAPIXELS = 0x00000001;
export const DDPF_FOURCC = 0x00000004;
export const DDPF_PALETTEINDEXED8 = 0x00000020;
export const DDPF_RGB = 0x00000040;
export const DDPF_ZBUFFER = 0x00000400;

export const DDBD_8  = 0x00000800;
export const DDBD_16 = 0x00000400;
export const DDBD_24 = 0x00000200;
export const DDBD_32 = 0x00000100;

export const DDSCAPS_PRIMARYSURFACE = 0x00000200;
export const DDSCAPS_BACKBUFFER = 0x00000004;
export const DDSCAPS_COMPLEX = 0x00000008;
export const DDSCAPS_FLIP = 0x00000010;
export const DDSCAPS_FRONTBUFFER = 0x00000020;
export const DDSCAPS_OVERLAY = 0x00000080;
export const DDSCAPS_SYSTEMMEMORY = 0x00000800;
export const DDSCAPS_VIDEOMEMORY = 0x00004000;
export const DDSCAPS_LOCALVIDMEM = 0x10000000;
export const DDSCAPS_TEXTURE = 0x00001000;
export const DDSCAPS_ZBUFFER = 0x00020000;
export const DDSCAPS_3DDEVICE = 0x00002000;
export const DDSCAPS_MIPMAP = 0x00400000;
export const DDSCAPS_ALLOCONLOAD = 0x04000000;

export const DDSD_CAPS = 0x00000001;
export const DDSD_HEIGHT = 0x00000002;
export const DDSD_WIDTH = 0x00000004;
export const DDSD_PITCH = 0x00000008;
export const DDSD_BACKBUFFERCOUNT = 0x00000020;
export const DDSD_PIXELFORMAT = 0x00001000;
export const DDSD_LPSURFACE = 0x00000800;
export const DDSD_CKDESTOVERLAY = 0x00002000; // ddckCKDestOverlay is valid
export const DDSD_CKDESTBLT = 0x00004000;     // ddckCKDestBlt is valid
export const DDSD_CKSRCOVERLAY = 0x00008000;  // ddckCKSrcOverlay is valid
export const DDSD_CKSRCBLT = 0x00010000;      // ddckCKSrcBlt is valid
export const DDSD_MIPMAPCOUNT = 0x00020000;   // dwMipMapCount is valid
export const DDSD_REFRESHRATE = 0x00040000;   // dwRefreshRate is valid

// DDLOCK flags for Lock/Unlock
export const DDLOCK_SURFACEMEMORYPTR = 0x00000000;
export const DDLOCK_WAIT = 0x00000001;
export const DDLOCK_EVENT = 0x00000002;
export const DDLOCK_READONLY = 0x00000010;
export const DDLOCK_WRITEONLY = 0x00000020;
export const DDLOCK_NOSYSLOCK = 0x00000800;
export const DDLOCK_NOOVERWRITE = 0x00001000;
export const DDLOCK_DISCARDCONTENTS = 0x00002000;
export const DDLOCK_OKTOSWAP = 0x00002000;
export const DDLOCK_DONOTWAIT = 0x00004000;
export const DDLOCK_HASVOLUMETEXTUREBOXRECT = 0x00008000;
export const DDLOCK_NODIRTYUPDATE = 0x00010000;

// DDBLT flags for Blt
export const DDBLT_COLORFILL = 0x00000400;
export const DDBLT_KEYSRC = 0x00008000;
export const DDBLT_KEYDEST = 0x00002000;
export const DDBLT_KEYSRCOVERRIDE = 0x00010000;
export const DDBLT_KEYDESTOVERRIDE = 0x00004000;
export const DDBLT_ROP = 0x00020000;
export const DDBLT_DEPTHFILL = 0x02000000;
export const DDBLT_WAIT = 0x01000000;

// DDBLTFX structure (ddraw.h) - used for Blt override fields
export const DDBLTFX_SIZE = 104;
export const DDBLTFX_OFFSETS = {
    rop: 8,                  // dwROP
    fillColor: 80,            // dwFillColor
    ddckDestColorkey: 88,     // DDCOLORKEY (8 bytes)
    ddckSrcColorkey: 96,      // DDCOLORKEY (8 bytes)
};

// DDBLTFAST flags for BltFast
export const DDBLTFAST_NOCOLORKEY = 0x00000000;
export const DDBLTFAST_SRCCOLORKEY = 0x00000001;
export const DDBLTFAST_DESTCOLORKEY = 0x00000002;
export const DDBLTFAST_WAIT = 0x00000010;

// DDSURFACEDESC (v1) - 108 bytes, uses DDSCAPS (4 bytes) instead of DDSCAPS2 (16 bytes)
export const DDSURFACEDESC_SIZE = 108;

export const DDSURFACEDESC_OFFSETS = {
    size: 0,
    flags: 4,
    height: 8,
    width: 12,
    pitch: 16,
    backBufferCount: 20,
    dwRefreshRate: 24,  // Union: dwZBufferBitDepth / dwRefreshRate
    lpSurface: 36, // Same offset as v2 - good!
    pixelFormat: 72, // Same offset as v2 - good!
    caps: 104, // DDSCAPS (4 bytes) vs DDSCAPS2 (16 bytes) in v2
};

export const DDSURFACEDESC2_SIZE = 124;

export const DDSURFACEDESC2_OFFSETS = {
    size: 0,
    flags: 4,
    height: 8,
    width: 12,
    pitch: 16,
    backBufferCount: 20,
    dwMipMapCount: 24,      // Union: dwMipMapCount / dwRefreshRate / dwSrcVBHandle
    dwAlphaBitDepth: 28,
    dwReserved: 32,
    lpSurface: 36,
    ddckCKDestOverlay: 40,  // DDCOLORKEY (8 bytes: low + high) - union with dwEmptyFaceColor
    ddckCKDestBlt: 48,       // DDCOLORKEY (8 bytes)
    ddckCKSrcOverlay: 56,   // DDCOLORKEY (8 bytes)
    ddckCKSrcBlt: 64,       // DDCOLORKEY (8 bytes)
    pixelFormat: 72,        // Union: DDPIXELFORMAT (32 bytes) / dwFVF
    caps: 104,              // DDSCAPS2 starts here (16 bytes: dwCaps, dwCaps2, dwCaps3, dwCaps4)
    dwCaps2: 108,           // DDSCAPS2.dwCaps2
    dwCaps3: 112,           // DDSCAPS2.dwCaps3
    dwCaps4: 116,           // DDSCAPS2.dwCaps4 / dwVolumeDepth (union)
    dwTextureStage: 120,    // Texture stage index for multi-texture
};

// DDCAPS structure size and offsets (DDCAPS_DX7 from ddraw.h, 380 bytes)
export const DDCAPS_SIZE_V7 = 380;

export const DDCAPS_OFFSETS = {
    dwSize: 0,
    dwCaps: 4,
    dwCaps2: 8,
    dwCKeyCaps: 12,
    dwFXCaps: 16,
    dwFXAlphaCaps: 20,
    dwPalCaps: 24,
    dwSVCaps: 28,
    dwAlphaBltConstBitDepths: 32,
    dwAlphaBltPixelBitDepths: 36,
    dwAlphaBltSurfaceBitDepths: 40,
    dwAlphaOverlayConstBitDepths: 44,
    dwAlphaOverlayPixelBitDepths: 48,
    dwAlphaOverlaySurfaceBitDepths: 52,
    dwZBufferBitDepths: 56,
    dwVidMemTotal: 60,
    dwVidMemFree: 64,
    dwMaxVisibleOverlays: 68,
    dwCurrVisibleOverlays: 72,
    dwNumFourCCCodes: 76,
    dwAlignBoundarySrc: 80,
    dwAlignSizeSrc: 84,
    dwAlignBoundaryDest: 88,
    dwAlignSizeDest: 92,
    dwAlignStrideAlign: 96,
    dwRops: 100,            // DWORD[8] = 32 bytes (100-131)
    ddsOldCaps: 132,        // DDSCAPS (4 bytes)
    dwMinOverlayStretch: 136,
    dwMaxOverlayStretch: 140,
    dwMinLiveVideoStretch: 144,
    dwMaxLiveVideoStretch: 148,
    dwMinHwCodecStretch: 152,
    dwMaxHwCodecStretch: 156,
    // dwReserved1-3: 160, 164, 168
    dwSVBCaps: 172,
    dwSVBCKeyCaps: 176,
    dwSVBFXCaps: 180,
    dwSVBRops: 184,         // DWORD[8] = 32 bytes (184-215)
    dwVSBCaps: 216,
    dwVSBCKeyCaps: 220,
    dwVSBFXCaps: 224,
    dwVSBRops: 228,         // DWORD[8] = 32 bytes (228-259)
    dwSSBCaps: 260,
    dwSSBCKeyCaps: 264,
    dwSSBFXCaps: 268,
    dwSSBRops: 272,         // DWORD[8] = 32 bytes (272-303)
    dwMaxVideoPorts: 304,
    dwCurrVideoPorts: 308,
    dwSVBCaps2: 312,
    dwNLVBCaps: 316,
    dwNLVBCaps2: 320,
    dwNLVBCKeyCaps: 324,
    dwNLVBFXCaps: 328,
    dwNLVBRops: 332,        // DWORD[8] = 32 bytes (332-363)
    ddsCaps: 364,           // DDSCAPS2 (16 bytes, 364-379)
};

// DDCKEYCAPS_ flags for dwCKeyCaps field (from ddraw.h)
export const DDCKEYCAPS_DESTBLT             = 0x00000001;
export const DDCKEYCAPS_DESTBLTCLRSPACE     = 0x00000002;
export const DDCKEYCAPS_DESTBLTCLRSPACEYUV  = 0x00000004;
export const DDCKEYCAPS_DESTBLTYUV          = 0x00000008;
export const DDCKEYCAPS_SRCBLT              = 0x00000200;
export const DDCKEYCAPS_SRCBLTCLRSPACE      = 0x00000400;
export const DDCKEYCAPS_SRCBLTCLRSPACEYUV   = 0x00000800;
export const DDCKEYCAPS_SRCBLTYUV           = 0x00001000;
export const DDCKEYCAPS_NOCOSTOVERLAY       = 0x00040000;

// Colorkey caps — matches real HW (only SRCBLT = 0x200)
export const CKCAPS_COMBINED = DDCKEYCAPS_SRCBLT; // 0x00000200

// DDCKEY flags for SetColorKey/GetColorKey
export const DDCKEY_COLORSPACE = 0x00000001;
export const DDCKEY_DESTBLT = 0x00000002;
export const DDCKEY_DESTOVERLAY = 0x00000004;
export const DDCKEY_SRCBLT = 0x00000008;
export const DDCKEY_SRCOVERLAY = 0x00000010;

// DDFXCAPS flags for dwFXCaps field
export const DDFXCAPS_BLTARITHSTRETCHY  = 0x00000020;
export const DDFXCAPS_BLTMIRRORLEFTRIGHT = 0x00000040;
export const DDFXCAPS_BLTMIRRORUPDOWN   = 0x00000080;
export const DDFXCAPS_BLTSHRINKX        = 0x00000400;
export const DDFXCAPS_BLTSHRINKY        = 0x00001000;
export const DDFXCAPS_BLTSTRETCHX       = 0x00004000;
export const DDFXCAPS_BLTSTRETCHY       = 0x00010000;
export const DDFXCAPS_COMBINED =
    DDFXCAPS_BLTARITHSTRETCHY |
    DDFXCAPS_BLTMIRRORLEFTRIGHT |
    DDFXCAPS_BLTMIRRORUPDOWN |
    DDFXCAPS_BLTSHRINKX |
    DDFXCAPS_BLTSHRINKY |
    DDFXCAPS_BLTSTRETCHX |
    DDFXCAPS_BLTSTRETCHY;

export const DDPCAPS_8BIT = 0x00000004;
export const DDPCAPS_ALLOW256 = 0x00000002;
export const DDPCAPS_COMBINED = DDPCAPS_8BIT | DDPCAPS_ALLOW256; // 0x00000006

export const DDSCAPS_COMBINED_3D = DDSCAPS_3DDEVICE | DDSCAPS_TEXTURE | DDSCAPS_ZBUFFER | DDSCAPS_VIDEOMEMORY | DDSCAPS_LOCALVIDMEM; // 0x10022000

// DDDEVICEIDENTIFIER structure size and offsets (DX6, IDirectDraw4::GetDeviceIdentifier)
// 512+512+8+4+4+4+4+16 = 1064 bytes — no dwWHQLLevel field
export const DDDEVICEIDENTIFIER_SIZE = 1064;

// DDDEVICEIDENTIFIER2 structure size and offsets (DX7, IDirectDraw7::GetDeviceIdentifier)
// Fields sum to 1068, but LARGE_INTEGER liDriverVersion gives the struct 8-byte alignment,
// so sizeof() rounds to 1072 — and sizeof() is what the guest's own memset/copy uses.
export const DDDEVICEIDENTIFIER2_SIZE = 1072;

export const DDDEVICEIDENTIFIER2_OFFSETS = {
    szDriver: 0,
    szDescription: 512,
    liDriverVersion: 1024,
    dwVendorId: 1032,
    dwDeviceId: 1036,
    dwSubSysId: 1040,
    dwRevision: 1044,
    guidDeviceIdentifier: 1048,
    dwWHQLLevel: 1064,  // DX7 only (DDDEVICEIDENTIFIER2); not present in DX6 DDDEVICEIDENTIFIER
};

export const DDDEVICEIDENTIFIER2_STRING_SIZE = 512;

// Surface allocation constants
export const MIN_SURFACE_SIZE = 0x1000; // 4KB minimum allocation

// Stack cleanup for stdcall functions
export const STACK_CLEANUP_DIRECTDRAWENUMERATEA = 8; // 2 args * 4 bytes
export const STACK_CLEANUP_DIRECTDRAWENUMERATEEXA = 12; // 3 args * 4 bytes
export const STACK_CLEANUP_ENUMDISPLAYMODES = 20; // 5 args * 4 bytes
export const STACK_CLEANUP_ENUMSURFACES = 20; // 5 args * 4 bytes

// DDENUMSURFACES flags
export const DDENUMSURFACES_ALL = 0x00000001;
export const DDENUMSURFACES_MATCH = 0x00000002;
export const DDENUMSURFACES_NOMATCH = 0x00000004;
export const DDENUMSURFACES_CANBECREATED = 0x00000008;
export const DDENUMSURFACES_DOESEXIST = 0x00000010;

// Memory regions
export const HIGH_MEMORY_COM_AREA = 0x10000000; // COM/thunk allocation area

// Debug/test constants
export const RGB565_MAGENTA = 0xF81F; // Magenta color in RGB565 format for debug fills

// Default device identifiers
export const DEFAULT_VENDOR_ID_AMD = 0x1002;
export const DEFAULT_DEVICE_ID_FAKE = 0x9999;
export const DEFAULT_DRIVER_VERSION = 0x0006000400020001n; // Version 6.4.2.1

export const DDPIXELFORMAT_OFFSETS = {
    size: 0,
    flags: 4,
    fourCC: 8,
    rgbBitCount: 12,
    rMask: 16,
    gMask: 20,
    bMask: 24,
    aMask: 28,
};

// DDPIXELFORMAT unions the depth-buffer members onto the RGB ones: dwZBufferBitDepth
// over dwRGBBitCount, dwStencilBitDepth over dwRBitMask, dwZBitMask over dwGBitMask,
// dwStencilBitMask over dwBBitMask. Same bytes, different names when DDPF_ZBUFFER is set.
export const DDPIXELFORMAT_Z_OFFSETS = {
    zBufferBitDepth: DDPIXELFORMAT_OFFSETS.rgbBitCount,
    stencilBitDepth: DDPIXELFORMAT_OFFSETS.rMask,
    zBitMask: DDPIXELFORMAT_OFFSETS.gMask,
    stencilBitMask: DDPIXELFORMAT_OFFSETS.bMask,
};

export {
    COM_OBJECT_SIZE,
    COM_GUARD_SIZE,
    COM_GUARD_VALUE,
    allocateComObject,
    checkComGuard
} from '../../core/com/com-memory';

export const D3DRENDERSTATE_TEXTUREHANDLE = 1;
export const D3DRENDERSTATE_ZENABLE = 7;
export const D3DRENDERSTATE_FILLMODE = 8;
export const D3DRENDERSTATE_SHADEMODE = 9;
export const D3DRENDERSTATE_ZWRITEENABLE = 14;
export const D3DRENDERSTATE_ALPHATESTENABLE = 15;
export const D3DRENDERSTATE_SRCBLEND = 19;
export const D3DRENDERSTATE_DESTBLEND = 20;
export const D3DRENDERSTATE_TEXTUREMAPBLEND = 21;
export const D3DRENDERSTATE_CULLMODE = 22;
export const D3DRENDERSTATE_ZFUNC = 23;
export const D3DRENDERSTATE_ALPHAREF = 24;
export const D3DRENDERSTATE_ALPHAFUNC = 25;
export const D3DRENDERSTATE_TEXTUREFACTOR = 60;

// Depth comparison functions (D3DCMP_*)
export const D3DCMP_NEVER = 1;
export const D3DCMP_LESS = 2;
export const D3DCMP_EQUAL = 3;
export const D3DCMP_LESSEQUAL = 4;
export const D3DCMP_GREATER = 5;
export const D3DCMP_NOTEQUAL = 6;
export const D3DCMP_GREATEREQUAL = 7;
export const D3DCMP_ALWAYS = 8;
export const D3DRENDERSTATE_DITHERENABLE = 26;
export const D3DRENDERSTATE_ALPHABLENDENABLE = 27;
export const D3DRENDERSTATE_FOGENABLE = 28;
export const D3DRENDERSTATE_SPECULARENABLE = 29;
export const D3DRENDERSTATE_FOGCOLOR = 34;
export const D3DRENDERSTATE_FOGTABLEMODE = 35;
export const D3DRENDERSTATE_FOGSTART = 36;
export const D3DRENDERSTATE_FOGEND = 37;
export const D3DRENDERSTATE_FOGDENSITY = 38;
export const D3DRENDERSTATE_FOGVERTEXMODE = 140;

// Fog modes (D3DFOG_*)
export const D3DFOG_NONE = 0;
export const D3DFOG_EXP = 1;
export const D3DFOG_EXP2 = 2;
export const D3DFOG_LINEAR = 3;
export const D3DRENDERSTATE_COLORKEYENABLE = 41;

// Depth bias for z-fighting prevention (D3DRENDERSTATE_ZBIAS)
// Range: 0-16, where 0 = no bias, higher values push geometry toward camera
export const D3DRENDERSTATE_ZBIAS = 47;

// Stencil render states (D3DRS_STENCIL*)
export const D3DRENDERSTATE_STENCILENABLE = 52;
export const D3DRENDERSTATE_STENCILFAIL = 53;
export const D3DRENDERSTATE_STENCILZFAIL = 54;
export const D3DRENDERSTATE_STENCILPASS = 55;
export const D3DRENDERSTATE_STENCILFUNC = 56;
export const D3DRENDERSTATE_STENCILREF = 57;
export const D3DRENDERSTATE_STENCILMASK = 58;
export const D3DRENDERSTATE_STENCILWRITEMASK = 59;

// Stencil operations (D3DSTENCILOP_*)
export const D3DSTENCILOP_KEEP = 1;      // Do not update stencil buffer
export const D3DSTENCILOP_ZERO = 2;      // Set stencil buffer entry to 0
export const D3DSTENCILOP_REPLACE = 3;   // Replace with reference value
export const D3DSTENCILOP_INCRSAT = 4;   // Increment with saturation (clamp to max)
export const D3DSTENCILOP_DECRSAT = 5;   // Decrement with saturation (clamp to 0)
export const D3DSTENCILOP_INVERT = 6;    // Invert stencil buffer entry
export const D3DSTENCILOP_INCR = 7;      // Increment (wrap to 0 if exceeds max)
export const D3DSTENCILOP_DECR = 8;      // Decrement (wrap to max if below 0)
export const D3DRENDERSTATE_LIGHTING = 137;
// D3DRS_VERTEXBLEND (151): D3DVBF_* selector. Value N = number of blend weights stored in
// the vertex (D3DFVF_XYZBn) → N+1-matrix fixed-function skinning against the
// D3DTS_WORLDMATRIX(0..N) palette. Same value D3D7/D3D8/D3D9.
export const D3DRENDERSTATE_VERTEXBLEND = 151;
// D3DRS_INDEXEDVERTEXBLENDENABLE (167): per-vertex UBYTE4 matrix indices
// (D3DFVF_LASTBETA_UBYTE4) select the palette entries instead of the vertex's ordinal.
export const D3DRENDERSTATE_INDEXEDVERTEXBLENDENABLE = 167;
// D3DVBF_* (D3DVERTEXBLENDFLAGS): the numeric weight count; matrix count = value + 1.
export const D3DVBF_DISABLE  = 0;   // no blending (single world matrix)
export const D3DVBF_1WEIGHTS = 1;   // 2 matrices, 1 explicit weight in the vertex
export const D3DVBF_2WEIGHTS = 2;   // 3 matrices, 2 explicit weights
export const D3DVBF_3WEIGHTS = 3;   // 4 matrices, 3 explicit weights
export const D3DVBF_TWEENING = 255; // position/normal tween (not blend palette)
export const D3DVBF_0WEIGHTS = 256; // 1 matrix selected via indices (indexed blend only)
// D3DRS_CLIPPLANEENABLE (152): bitmask, bit N enables user clip plane N. Same value in
// D3D7/D3D8/D3D9. FFP user clip planes are evaluated in WORLD space (see shader-generator).
export const D3DRENDERSTATE_CLIPPLANEENABLE = 152;
export const D3DRENDERSTATE_AMBIENT = 139;
export const D3DRENDERSTATE_COLORVERTEX = 141;
export const D3DRENDERSTATE_LOCALVIEWER = 142;
export const D3DRENDERSTATE_NORMALIZENORMALS = 143;
export const D3DRENDERSTATE_DIFFUSEMATERIALSOURCE = 145;
export const D3DRENDERSTATE_SPECULARMATERIALSOURCE = 146;
export const D3DRENDERSTATE_AMBIENTMATERIALSOURCE = 147;
export const D3DRENDERSTATE_EMISSIVEMATERIALSOURCE = 148;

// Point-sprite render states (D3DRS_POINT*). Numeric values are the canonical
// d3d8types.h / d3d9types.h D3DRENDERSTATETYPE ordinals (stable across D3D8/D3D9).
// All the *SIZE*/*SCALE_* values are FLOATs stored bit-cast into the DWORD render state.
export const D3DRENDERSTATE_POINTSIZE = 154;         // effective point size (float px)
export const D3DRENDERSTATE_POINTSIZE_MIN = 155;     // clamp lower bound (float px)
export const D3DRENDERSTATE_POINTSPRITEENABLE = 156; // BOOL: generate [0,1]² sprite texcoords
export const D3DRENDERSTATE_POINTSCALEENABLE = 157;  // BOOL: distance attenuation
export const D3DRENDERSTATE_POINTSCALE_A = 158;      // attenuation constant A (float)
export const D3DRENDERSTATE_POINTSCALE_B = 159;      // attenuation linear   B (float)
export const D3DRENDERSTATE_POINTSCALE_C = 160;      // attenuation quadratic C (float)
export const D3DRENDERSTATE_POINTSIZE_MAX = 166;     // clamp upper bound (float px)

// Transform state types
export const D3DTS_WORLD = 256;
export const D3DTS_VIEW = 2;
export const D3DTS_PROJECTION = 3;

export const D3DCULL_NONE = 1;
export const D3DCULL_CW = 2;
export const D3DCULL_CCW = 3;

// Z-Buffer enable values (D3DZB_*)
export const D3DZB_FALSE = 0;
export const D3DZB_TRUE = 1;
export const D3DZB_USEW = 2; // Use W-buffer instead of Z-buffer

// Fill modes (D3DFILL_*)
export const D3DFILL_POINT = 1;
export const D3DFILL_WIREFRAME = 2;
export const D3DFILL_SOLID = 3;

// Shade modes (D3DSHADE_*)
export const D3DSHADE_FLAT = 1;
export const D3DSHADE_GOURAUD = 2;
export const D3DSHADE_PHONG = 3;

export const D3DBLEND_ZERO = 1;
export const D3DBLEND_ONE = 2;
export const D3DBLEND_SRCCOLOR = 3;
export const D3DBLEND_INVSRCCOLOR = 4;
export const D3DBLEND_SRCALPHA = 5;
export const D3DBLEND_INVSRCALPHA = 6;
export const D3DBLEND_DESTALPHA = 7;
export const D3DBLEND_INVDESTALPHA = 8;
export const D3DBLEND_DESTCOLOR = 9;
export const D3DBLEND_INVDESTCOLOR = 10;

// Primitive types
export const D3DPT_POINTLIST = 1;
export const D3DPT_LINELIST = 2;
export const D3DPT_LINESTRIP = 3;
export const D3DPT_TRIANGLELIST = 4;
export const D3DPT_TRIANGLESTRIP = 5;
export const D3DPT_TRIANGLEFAN = 6;

// FVF flags
export const D3DFVF_XYZ = 0x0002;
export const D3DFVF_XYZRHW = 0x0004;
export const D3DFVF_NORMAL = 0x0010;

// Position mask + variants (D3D7). Parse position type via (fvf & D3DFVF_POSITION_MASK).
export const D3DFVF_POSITION_MASK = 0x400e;
export const D3DFVF_XYZW = 0x4002;
export const D3DFVF_XYZB1 = 0x4006;
export const D3DFVF_XYZB2 = 0x4008;
export const D3DFVF_XYZB3 = 0x400a;
export const D3DFVF_XYZB4 = 0x400c;
export const D3DFVF_XYZB5 = 0x400e;
export const D3DFVF_LASTBETA_UBYTE4 = 0x1000;
export const D3DFVF_LASTBETA_D3DCOLOR = 0x8000;

// D3DMULTISAMPLE_TYPE (d3d8types.h / d3d9types.h). Value = sample count for the n_SAMPLES
// members; NONE=0 (single-sample), NONMASKABLE=1 (driver-chosen quality, no fixed count).
export const D3DMULTISAMPLE_NONE = 0;
export const D3DMULTISAMPLE_NONMASKABLE = 1;
export const D3DMULTISAMPLE_2_SAMPLES = 2;
export const D3DMULTISAMPLE_3_SAMPLES = 3;
export const D3DMULTISAMPLE_4_SAMPLES = 4;
export const D3DFVF_PSIZE = 0x0020;
export const D3DFVF_DIFFUSE = 0x0040;
export const D3DFVF_SPECULAR = 0x0080;
export const D3DFVF_TEX1 = 0x0100;
export const D3DFVF_TEX2 = 0x0200;
export const D3DFVF_TEX3 = 0x0300;
export const D3DFVF_TEX4 = 0x0400;
export const D3DFVF_TEX5 = 0x0500;
export const D3DFVF_TEX6 = 0x0600;
export const D3DFVF_TEX7 = 0x0700;
export const D3DFVF_TEX8 = 0x0800;
// Texture coordinate count extraction (for T&L pipeline)
export const D3DFVF_TEXCOUNT_MASK = 0xf00;
export const D3DFVF_TEXCOUNT_SHIFT = 8;

// D3D transform state indices for SetTransform()
export const D3DTRANSFORMSTATE_TEXTURE0 = 16; // First texture matrix (D3D3/D3D5/D3D7)
export const D3DTRANSFORMSTATE_TEXTURE1 = 17;
export const D3DTRANSFORMSTATE_TEXTURE2 = 18;
export const D3DTRANSFORMSTATE_TEXTURE3 = 19;
export const D3DTRANSFORMSTATE_TEXTURE4 = 20;
export const D3DTRANSFORMSTATE_TEXTURE5 = 21;
export const D3DTRANSFORMSTATE_TEXTURE6 = 22;
export const D3DTRANSFORMSTATE_TEXTURE7 = 23;

// Texture stage states (D3DTSS_*) — indices match D3D7 SDK (stage * 32 + type)
export const D3DTSS_COLOROP = 1;
export const D3DTSS_COLORARG1 = 2;
export const D3DTSS_COLORARG2 = 3;
export const D3DTSS_ALPHAOP = 4;
export const D3DTSS_ALPHAARG1 = 5;
export const D3DTSS_ALPHAARG2 = 6;
export const D3DTSS_TEXTURETRANSFORMFLAGS = 24;

// Texture coordinate transform flags (value of D3DTSS_TEXTURETRANSFORMFLAGS).
// COUNTn = number of output coordinates produced by the stage's texture matrix;
// PROJECTED divides the output by the last (count-1) component.
export const D3DTTFF_DISABLE = 0;
export const D3DTTFF_COUNT1 = 1;
export const D3DTTFF_COUNT2 = 2;
export const D3DTTFF_COUNT3 = 3;
export const D3DTTFF_COUNT4 = 4;
export const D3DTTFF_PROJECTED = 0x100;
export {
    D3DRENDERSTATE_TEXTUREADDRESS,
    D3DRENDERSTATE_TEXTUREMAG,
    D3DRENDERSTATE_TEXTUREMIN,
    D3DRENDERSTATE_TEXTUREADDRESSU,
    D3DRENDERSTATE_TEXTUREADDRESSV,
    D3DRENDERSTATE_ANISOTROPY,
    D3DTSS_TEXCOORDINDEX,
    D3DTSS_ADDRESSU,
    D3DTSS_ADDRESSV,
    D3DTSS_MINFILTER,
    D3DTSS_MAGFILTER,
    D3DTSS_MIPFILTER,
    D3DTSS_MAXANISOTROPY,
    D3DTADDRESS_WRAP,
    D3DTADDRESS_MIRROR,
    D3DTADDRESS_CLAMP,
    D3DTADDRESS_BORDER,
    D3DTFN_POINT,
    D3DTFN_LINEAR,
    D3DTFN_ANISOTROPIC,
    D3DTFG_POINT,
    D3DTFG_LINEAR,
    D3DTFG_ANISOTROPIC,
    D3DTFP_NONE,
    D3DTFP_POINT,
    D3DTFP_LINEAR,
    D3DFILTER_NEAREST,
    D3DFILTER_LINEAR,
    D3DFILTER_MIPNEAREST,
    D3DFILTER_MIPLINEAR,
    D3DFILTER_LINEARMIPNEAREST,
    D3DFILTER_LINEARMIPLINEAR,
} from "./d3d/sampler-constants";

// Texture operations (D3DTOP_*)
export const D3DTOP_DISABLE = 1;      // Disable this texture stage
export const D3DTOP_SELECTARG1 = 2;   // Output = arg1 (typically texture)
export const D3DTOP_SELECTARG2 = 3;   // Output = arg2 (typically diffuse/vertex color)
export const D3DTOP_MODULATE = 4;     // Output = arg1 * arg2
export const D3DTOP_MODULATE2X = 5;   // Output = arg1 * arg2 * 2
export const D3DTOP_MODULATE4X = 6;   // Output = arg1 * arg2 * 4
export const D3DTOP_ADD = 7;          // Output = arg1 + arg2
export const D3DTOP_ADDSIGNED = 8;    // Output = arg1 + arg2 - 0.5
export const D3DTOP_ADDSIGNED2X = 9;  // Output = (arg1 + arg2 - 0.5) * 2
export const D3DTOP_SUBTRACT = 10;    // Output = arg1 - arg2
// NOTE: these MUST match the real D3DTEXTUREOP enum (wine d3dtypes.h/d3d8types.h/d3d9types.h all agree):
// ...SUBTRACT=10, ADDSMOOTH=11, BLENDDIFFUSEALPHA=12, BLENDTEXTUREALPHA=13, BLENDFACTORALPHA=14...
// They were previously mis-numbered (TEXTUREALPHA=11/FACTORALPHA=12/DIFFUSEALPHA=13), so a game sending
// 13 (BLENDTEXTUREALPHA) was rendered as BLENDDIFFUSEALPHA. The shader-generator keys off the symbolic
// names, so correcting the values here fixes the WGSL combine automatically.
export const D3DTOP_ADDSMOOTH = 11;          // Output = arg1 + arg2 - arg1*arg2 (no WGSL impl yet → MODULATE fallback)
export const D3DTOP_BLENDDIFFUSEALPHA = 12;  // Output = arg1 * diffuse.a + arg2 * (1 - diffuse.a)
export const D3DTOP_BLENDTEXTUREALPHA = 13;  // Output = arg1 * tex.a     + arg2 * (1 - tex.a)
export const D3DTOP_BLENDFACTORALPHA = 14;   // Output = arg1 * factor.a  + arg2 * (1 - factor.a)

// Texture argument flags (D3DTA_*)
export const D3DTA_SELECTMASK = 0x0000000f;  // Mask for argument selection
export const D3DTA_DIFFUSE = 0x00000000;     // Use diffuse color
export const D3DTA_CURRENT = 0x00000001;     // Use current stage output
export const D3DTA_TEXTURE = 0x00000002;    // Use texture color
export const D3DTA_TFACTOR = 0x00000003;     // Use texture factor (D3DRENDERSTATE_TEXTUREFACTOR)
export const D3DTA_COMPLEMENT = 0x00000010;  // Complement modifier (1.0 - value)
export const D3DTA_ALPHAREPLICATE = 0x00000020; // Replicate alpha channel to RGB

// Clear flags
export const D3DCLEAR_TARGET = 1;
export const D3DCLEAR_ZBUFFER = 2;
export const D3DCLEAR_STENCIL = 4;

// Interface IDs (GUIDs) - normalized (lowercase, no braces)
export const IID_IDirectDraw = "6c14db80-a733-11ce-a521-0020af0be560";
export const IID_IDirectDrawAlias = "d7b70ee0-4340-11d0-b427-00aa00bbad51";
export const IID_IDirectDraw2 = "b3a6f3e0-2b43-11cf-a2de-00aa00b93356";
export const IID_IDirectDraw4 = "9c59509a-39bd-11d1-8c4a-00c04fd930c5";
export const IID_IDirectDraw7 = "15e65ec0-3b9c-11d2-b92f-00609797ea5b";
export const IID_IDirectDrawSurface = "6c14db81-a733-11ce-a521-0020af0be560";
export const IID_IDirectDrawSurface2 = "57805885-6eec-11cf-9441-a82303c10e27";
export const IID_IDirectDrawSurface3 = "da044e00-69b2-11d0-a1d5-00aa00b8dfbb";
export const IID_IDirectDrawSurface4 = "0b2b8630-ad35-11d0-8ea6-00609797ea5b";
export const IID_IDirectDrawSurface7 = "06675a80-3b9b-11d2-b92f-00609797ea5b";
export const IID_IDirectDrawClipper = "6c14db85-a733-11ce-a521-0020af0be560";
export const IID_IDirectDrawPalette = "6c14db84-a733-11ce-a521-0020af0be560";
export const IID_IDirectDrawGammaControl = "69c11c3e-b46b-11d1-ad7a-00c04fc29b4e";

// DDCAPS2 extension flags
export const DDCAPS2_PRIMARYGAMMA = 0x00020000;

// Gamma ramp constants
export const DDSGR_CALIBRATE = 0x00000001;
export const DDGAMMARAMP_SIZE = 1536; // 256 * 2 * 3 (red[256], green[256], blue[256] as WORD arrays)

// DDFLIP flags. NOVSYNC and INTERVAL2/3/4 are DirectDraw's spelling of a present
// interval — the same request D3DPRESENT_INTERVAL_* makes (see frame-pacer).
export const DDFLIP_WAIT = 0x00000001;
export const DDFLIP_NOVSYNC = 0x00000008;
export const DDFLIP_INTERVAL2 = 0x02000000;
export const DDFLIP_INTERVAL3 = 0x04000000;
export const DDFLIP_INTERVAL4 = 0x08000000;

export const IID_IDirect3D = "3bba0080-2421-11cf-a31a-00aa00b93356";
export const IID_IDirect3D2 = "6aae1ec1-662a-11d0-889d-00aa00bbb76a";
export const IID_IDirect3D3 = "bb223240-e72b-11d0-a9b4-00aa00c0993e";
export const IID_IDirect3D7 = "f5049e77-4861-11d2-a407-00a0c90629a8";
export const IID_IDirect3DDevice = "64108800-957d-11d0-89ab-00a0c9054129";
export const IID_IDirect3DDevice2 = "93281501-8cf8-11d0-89ab-00a0c9054129";
export const IID_IDirect3DDevice3 = "b0ab3b60-33d7-11d1-a981-00c04fd7b174";
export const IID_IDirect3DDevice3V5 = "b0ab3b60-33d7-11d1-a981-00c04fd7b174";
export const IID_IDirect3DDevice7 = "f5049e79-4861-11d2-a407-00a0c90629a8";
export const IID_IDirect3DViewport = "4417c146-33ad-11cf-816f-0000c020156e"; // IDirect3DViewport (v1)
export const IID_IDirect3DViewport2 = "93281500-8cf8-11d0-89ab-00a0c9054129";
export const IID_IDirect3DViewport3 = "b0ab3b61-33d7-11d1-a981-00c04fd7b174";
export const IID_IDirect3DTexture = "2cdcd9e0-25a0-11cf-a31a-00aa00b93356";
export const IID_IDirect3DTexture2 = "93281502-8cf8-11d0-89ab-00a0c9054129";
// Device GUIDs for EnumDevices/CreateDevice
export const IID_IDirect3DRGBDevice = "a4665c60-2673-11cf-a31a-00aa00b93356";
export const IID_IDirect3DHALDevice = "84e63de0-46aa-11cf-816f-0000c020156e";
export const IID_IDirect3DRampDevice = "f2086b20-259f-11cf-a31a-00aa00b93356";
export const IID_IDirect3DMMXDevice = "881949a1-d6f3-11d0-89ab-00a0c9054129";
export const IID_IDirect3DTnLHalDevice = "f5049e78-4861-11d2-a407-00a0c90629a8";
export const IID_IDirect3DExecuteBuffer = "4417c145-33ad-11cf-816f-0000c020156e";
export const IID_IDirect3DLight = "4417c142-33ad-11cf-816f-0000c020156e";
export const IID_IDirect3DMaterial = "4417c144-33ad-11cf-816f-0000c020156e";
export const IID_IDirect3DMaterial2 = "93281503-8cf8-11d0-89ab-00a0c9054129";
export const IID_IDirect3DMaterial3 = "ca9c46f4-d3c5-11d1-b75a-00600852b312";
export const IID_IDirect3DVertexBuffer = "7a503555-4a83-11d1-a5db-00a0c9032656";
export const IID_IDirect3DVertexBuffer7 = "f5049e7d-4861-11d2-a407-00a0c90629a8";

// PALETTEENTRY structure size and offsets
export const PALETTEENTRY_SIZE = 4;

export const PALETTEENTRY_OFFSETS = {
    peRed: 0,
    peGreen: 1,
    peBlue: 2,
    peFlags: 3,
};

// ============================================================================
// D3D7 Lighting System Structures
// ============================================================================

// D3DLIGHTTYPE enumeration
export const D3DLIGHT_POINT = 1;        // Point light (omni-directional)
export const D3DLIGHT_SPOT = 2;         // Spotlight
export const D3DLIGHT_DIRECTIONAL = 3;  // Directional light (sun-like)

// D3DCOLORVALUE structure (16 bytes: r, g, b, a floats)
export const D3DCOLORVALUE_SIZE = 16;
export const D3DCOLORVALUE_OFFSETS = {
    r: 0,   // float
    g: 4,   // float
    b: 8,   // float
    a: 12,  // float
};

// D3DMATERIAL7 structure (68 bytes total)
// Contains diffuse, ambient, specular, emissive colors and specular power
export const D3DMATERIAL7_SIZE = 68;
export const D3DMATERIAL7_OFFSETS = {
    diffuse: 0,     // D3DCOLORVALUE (16 bytes)
    ambient: 16,    // D3DCOLORVALUE (16 bytes)
    specular: 32,   // D3DCOLORVALUE (16 bytes)
    emissive: 48,   // D3DCOLORVALUE (16 bytes)
    power: 64,      // float - specular power (shininess)
};

// D3DVECTOR structure (12 bytes: x, y, z floats)
export const D3DVECTOR_SIZE = 12;
export const D3DVECTOR_OFFSETS = {
    x: 0,   // float
    y: 4,   // float
    z: 8,   // float
};

// D3DLIGHT7 structure (104 bytes total)
// Contains light type, colors, position, direction, and attenuation parameters
export const D3DLIGHT7_SIZE = 104;
export const D3DLIGHT7_OFFSETS = {
    type: 0,            // D3DLIGHTTYPE (DWORD)
    diffuse: 4,         // D3DCOLORVALUE (16 bytes)
    specular: 20,       // D3DCOLORVALUE (16 bytes)
    ambient: 36,        // D3DCOLORVALUE (16 bytes)
    position: 52,       // D3DVECTOR (12 bytes) - only for point/spot
    direction: 64,      // D3DVECTOR (12 bytes) - only for directional/spot
    range: 76,          // float - distance beyond which light has no effect
    falloff: 80,        // float - spot falloff factor (usually 1.0)
    attenuation0: 84,   // float - constant attenuation
    attenuation1: 88,   // float - linear attenuation
    attenuation2: 92,   // float - quadratic attenuation
    theta: 96,          // float - spot inner cone angle (radians)
    phi: 100,           // float - spot outer cone angle (radians)
};

// D3DVIEWPORT7 structure (24 bytes total).
// Unlike D3DVIEWPORT and D3DVIEWPORT2 it has NO leading dwSize member — it starts at dwX
// (d3dtypes.h). Reading one as if it did shifts every field by a DWORD and yields a 0x0
// viewport for the common x=0 case.
export const D3DVIEWPORT7_SIZE = 24;
export const D3DVIEWPORT7_OFFSETS = {
    x: 0,       // dwX (DWORD)
    y: 4,       // dwY (DWORD)
    width: 8,   // dwWidth (DWORD)
    height: 12, // dwHeight (DWORD)
    minZ: 16,   // dvMinZ (float)
    maxZ: 20,   // dvMaxZ (float)
};

// D3D7 supports up to 8 hardware lights (typically)
export const D3D_MAX_LIGHTS = 8;

// State block types for CreateStateBlock
export const D3DSBT_ALL = 1;          // Capture all state
export const D3DSBT_PIXELSTATE = 2;   // Capture pixel processing state
export const D3DSBT_VERTEXSTATE = 3;  // Capture vertex processing state
