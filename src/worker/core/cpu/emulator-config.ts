export const EMU_MEMORY_SIZE = 1024 * 1024 * 1024; // 1 GB (increased from 512 MB for large allocations)
export const EMU_VGA_MEMORY_SIZE = 8 * 1024 * 1024;
// Largest single allocation the guest heap will accept. Purely a corrupted/garbage-size
// guard — the real ceiling is the bucket's free space (an oversize request fails there →
// caller gets NULL). Matches EMU_MEMORY_SIZE so any allocation that could physically fit
// the address space is attempted rather than rejected outright (GTA3 New Game OOM crash).
export const MAX_ALLOC_BYTES = 0x40000000; // 1 GB
// ============================================================================
// Memory Layout Configuration
// Region-based memory allocation with hard separation and guard zones
// Total addressable space: 1GB (EMU_MEMORY_SIZE)
// ============================================================================

// LOW_MEM: 0x00000000-0x00100000 (1MB) - DOS/BIOS compatibility region
export const MEM_LOWMEM_BASE = 0x00000000;
export const MEM_LOWMEM_SIZE = 0x00100000;

// HEAP: Main application heap for VirtualAlloc, HeapAlloc, etc.
// Expanded to 512MB for memory-intensive games (Heroes 3, NFS, etc.)
export const MEM_HEAP_BASE = 0x01000000;      // 16MB start
export const MEM_HEAP_SIZE = 0x20000000;      // 512MB (was 176MB)

// THUNK_CODE: Executable thunk stubs (callbacks, API trampolines)
// Must be RX-only and never overlap with writable regions
export const MEM_THUNK_CODE_BASE = 0x21000000;  // After HEAP
export const MEM_THUNK_CODE_SIZE = 0x01000000;  // 16MB

// THUNK_DATA: Thunk-related data structures
export const MEM_THUNK_DATA_BASE = 0x22000000;  // After THUNK_CODE
export const MEM_THUNK_DATA_SIZE = 0x01000000;  // 16MB

// GUARD: Red zone between THUNK and ROM/MODULES
// NOACCESS region to catch buffer overruns
export const MEM_GUARD_BASE = 0x23000000;       // After THUNK_DATA
export const MEM_GUARD_SIZE = 0x01000000;       // 16MB
// (mirrored in Rust as FASTMEM_GUARD_BASE/SIZE — change both or fastmem refuses to arm)

// PAGE_TABLES: x86 page directory (4KB) + 1024 page tables (4MB) for the identity map,
// parked in the upper half of the red zone. It has to live somewhere no PE image can
// reach: an EXE mapped at ImageBase 0x00400000 with a multi-MB BSS covers the whole low
// gap, and an overlap is silent and lethal — the page walker's A/D-bit writes land in the
// guest's globals and the guest's writes land in our PTEs. The red zone is already
// NOACCESS, never allocated from, and excluded from the fastmem envelope.
export const MEM_PAGETABLE_BASE = 0x23800000;
export const MEM_PAGETABLE_SIZE = 0x00801000;   // PD + 1024 PTs

// ROM/MODULES: PE executables and DLLs
// Games typically load at 0x00400000 or 0x10000000+ ImageBase
export const MEM_ROM_BASE = 0x24000000;         // After GUARD
export const MEM_ROM_SIZE = 0x08000000;         // 128MB

// SURFACE_PIXELS: DirectDraw surface pixel data — placed LAST so it can expand
// freely via expandLayoutBucket up to the end of RAM. Texture-heavy hidden-object
// games (Natalie Brooks) chew through hundreds of MB of 1024x1024 SYSMEM textures.
// Default 320MB; layout clamps to actual RAM size (EMU_MEMORY_SIZE) at init.
export const MEM_SURFACE_BASE = 0x2C000000;   // After ROM
export const MEM_SURFACE_SIZE = 0x14000000;   // 320MB default — ends at 0x40000000 (= 1GB)

// Threading and scheduling configuration
// REDUCED: 1ms interval for highest resolution (clamped by browser to ~4ms)
export const EMU_SCHEDULER_INTERVAL_MS = 1;
// REDUCED: 2ms quantum for smoother animation with many threads (10 threads = ~20ms latency)
export const EMU_SCHEDULER_MIN_QUANTUM_MS = 2;

export const EMU_HEARTBEAT_INTERVAL_MS = 2000; // Diagnostics heartbeat interval
export const EMU_AUDIO_SAMPLE_UPDATE_INTERVAL_MS = 200; // Playing samples position update interval

// ============================================================================
// DirectDraw / Direct3D Capability Configuration
// These values are reported to games via GetCaps/EnumDevices
// Can be overridden per-game in manifest
// ============================================================================

// DDCAPS flags (IDirectDraw::GetCaps dwCaps) — from ddraw.h
export const DDCAPS_3D              = 0x00000001;
export const DDCAPS_BLT             = 0x00000040;
export const DDCAPS_BLTQUEUE        = 0x00000080;
export const DDCAPS_BLTFOURCC       = 0x00000100;
export const DDCAPS_BLTSTRETCH      = 0x00000200;
export const DDCAPS_GDI             = 0x00000400;
export const DDCAPS_OVERLAY         = 0x00000800;
export const DDCAPS_PALETTE         = 0x00008000;
export const DDCAPS_PALETTEVSYNC    = 0x00010000;
export const DDCAPS_READSCANLINE    = 0x00020000;
export const DDCAPS_ZBLTS           = 0x00100000;
export const DDCAPS_COLORKEY        = 0x00400000;
export const DDCAPS_ALPHA           = 0x00800000;
export const DDCAPS_COLORKEYHWASSIST = 0x01000000;
export const DDCAPS_BLTCOLORFILL    = 0x04000000;
export const DDCAPS_BLTDEPTHFILL    = 0x10000000;
export const DDCAPS_CANCLIP         = 0x20000000;
export const DDCAPS_CANCLIPSTRETCHED = 0x40000000;
export const DDCAPS_CANBLTSYSMEM    = 0x80000000;

// DDCAPS2 flags (IDirectDraw::GetCaps dwCaps2)
export const DDCAPS2_CERTIFIED = 0x00000001;
export const DDCAPS2_NO2DDURING3DSCENE = 0x00000002;
export const DDCAPS2_CANMANAGETEXTURE = 0x00000008;
export const DDCAPS2_TEXMANINNONLOCALVIDMEM = 0x00000800;
export const DDCAPS2_PRIMARYGAMMA = 0x00020000;
export const DDCAPS2_CANRENDERWINDOWED = 0x00080000;

// D3DDEVICEDESC dwFlags - indicates which fields are valid
export const D3DDD_COLORMODEL = 0x00000001;
export const D3DDD_DEVCAPS = 0x00000002;
export const D3DDD_TRANSFORMCAPS = 0x00000004;
export const D3DDD_LIGHTINGCAPS = 0x00000008;
export const D3DDD_BCLIPPING = 0x00000010;
export const D3DDD_LINECAPS = 0x00000020;
export const D3DDD_TRICAPS = 0x00000040;
export const D3DDD_DEVICERENDERBITDEPTH = 0x00000080;
export const D3DDD_DEVICEZBUFFERBITDEPTH = 0x00000100;
export const D3DDD_MAXBUFFERSIZE = 0x00000200;
export const D3DDD_MAXVERTEXCOUNT = 0x00000400;

// D3DTRANSFORMCAPS (d3dcaps.h)
export const D3DTRANSFORMCAPS_CLIP = 0x00000001;

// D3DLIGHTINGCAPS (d3dcaps.h) - dwLightingModel
export const D3DLIGHTINGMODEL_RGB = 0x00000001;
export const D3DLIGHTINGMODEL_MONO = 0x00000002;
// D3DLIGHTINGCAPS - dwCaps (light types)
export const D3DLIGHTCAPS_POINT = 0x00000001;
export const D3DLIGHTCAPS_SPOT = 0x00000002;
export const D3DLIGHTCAPS_DIRECTIONAL = 0x00000004;
export const D3DLIGHTCAPS_PARALLELPOINT = 0x00000008;
export const D3DLIGHTCAPS_GLSPOT = 0x00000010;

// D3DDEVICEDESC dwDevCaps - device capabilities
export const D3DDEVCAPS_FLOATTLVERTEX = 0x00000001;
export const D3DDEVCAPS_SORTINCREASINGZ = 0x00000002;
export const D3DDEVCAPS_SORTDECREASINGZ = 0x00000004;
export const D3DDEVCAPS_SORTEXACT = 0x00000008;
export const D3DDEVCAPS_EXECUTESYSTEMMEMORY = 0x00000010;
export const D3DDEVCAPS_EXECUTEVIDEOMEMORY = 0x00000020;
export const D3DDEVCAPS_TLVERTEXSYSTEMMEMORY = 0x00000040;
export const D3DDEVCAPS_TLVERTEXVIDEOMEMORY = 0x00000080;
export const D3DDEVCAPS_TEXTURESYSTEMMEMORY = 0x00000100;
export const D3DDEVCAPS_TEXTUREVIDEOMEMORY = 0x00000200;
export const D3DDEVCAPS_DRAWPRIMTLVERTEX = 0x00000400;
export const D3DDEVCAPS_CANRENDERAFTERFLIP = 0x00000800;
export const D3DDEVCAPS_TEXTURENONLOCALVIDMEM = 0x00001000;
export const D3DDEVCAPS_DRAWPRIMITIVES2 = 0x00002000;
export const D3DDEVCAPS_DRAWPRIMITIVES2EX = 0x00008000;
export const D3DDEVCAPS_HWTRANSFORMANDLIGHT = 0x00010000;
export const D3DDEVCAPS_CANBLTSYSTONONLOCAL = 0x00020000;
export const D3DDEVCAPS_HWRASTERIZATION = 0x00080000;

// D3DPRIMCAPS dwTextureCaps - texture capabilities (d3dcaps.h)
export const D3DPTEXTURECAPS_PERSPECTIVE = 0x00000001;
export const D3DPTEXTURECAPS_POW2 = 0x00000002;        // Requires power-of-two textures (NOT set on modern HW)
export const D3DPTEXTURECAPS_ALPHA = 0x00000004;
export const D3DPTEXTURECAPS_TRANSPARENCY = 0x00000008;
export const D3DPTEXTURECAPS_BORDER = 0x00000010;
export const D3DPTEXTURECAPS_SQUAREONLY = 0x00000020;
export const D3DPTEXTURECAPS_TEXREPEATNOTSCALEDBYSIZE = 0x00000040;
export const D3DPTEXTURECAPS_ALPHAPALETTE = 0x00000080;
export const D3DPTEXTURECAPS_PROJECTED = 0x00000400;
export const D3DPTEXTURECAPS_CUBEMAP = 0x00000800;
// DX6/DX7 extension (not in classic d3dcaps.h)
export const D3DPTEXTURECAPS_COLORKEYBLEND = 0x00001000;

// D3DPRIMCAPS dwTextureFilterCaps
export const D3DPTFILTERCAPS_NEAREST = 0x00000001;
export const D3DPTFILTERCAPS_LINEAR = 0x00000002;
export const D3DPTFILTERCAPS_MIPNEAREST = 0x00000004;
export const D3DPTFILTERCAPS_MIPLINEAR = 0x00000008;
export const D3DPTFILTERCAPS_LINEARMIPNEAREST = 0x00000010;
export const D3DPTFILTERCAPS_LINEARMIPLINEAR = 0x00000020;
export const D3DPTFILTERCAPS_MINFPOINT = 0x00000100;
export const D3DPTFILTERCAPS_MINFLINEAR = 0x00000200;
export const D3DPTFILTERCAPS_MINFANISOTROPIC = 0x00000400;
export const D3DPTFILTERCAPS_MIPFPOINT = 0x00010000;
export const D3DPTFILTERCAPS_MIPFLINEAR = 0x00020000;
export const D3DPTFILTERCAPS_MAGFPOINT = 0x01000000;
export const D3DPTFILTERCAPS_MAGFLINEAR = 0x02000000;

// D3DPRIMCAPS dwTextureBlendCaps (d3dcaps.h)
export const D3DPTBLENDCAPS_DECAL = 0x00000001;
export const D3DPTBLENDCAPS_MODULATE = 0x00000002;
export const D3DPTBLENDCAPS_DECALALPHA = 0x00000004;
export const D3DPTBLENDCAPS_MODULATEALPHA = 0x00000008;
export const D3DPTBLENDCAPS_DECALMASK = 0x00000010;
export const D3DPTBLENDCAPS_MODULATEMASK = 0x00000020;
export const D3DPTBLENDCAPS_COPY = 0x00000040;
export const D3DPTBLENDCAPS_ADD = 0x00000080;  // DX6+ extension

// D3DPRIMCAPS dwTextureAddressCaps
export const D3DPTADDRESSCAPS_WRAP = 0x00000001;
export const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
export const D3DPTADDRESSCAPS_CLAMP = 0x00000004;

// D3DPRIMCAPS dwMiscCaps (d3dcaps.h)
export const D3DPMISCCAPS_MASKPLANES = 0x00000001;
export const D3DPMISCCAPS_MASKZ = 0x00000002;
export const D3DPMISCCAPS_LINEPATTERNREP = 0x00000004;
export const D3DPMISCCAPS_CONFORMANT = 0x00000008;
export const D3DPMISCCAPS_CULLNONE = 0x00000010;
export const D3DPMISCCAPS_CULLCW = 0x00000020;
export const D3DPMISCCAPS_CULLCCW = 0x00000040;

// D3DPRIMCAPS dwShadeCaps (d3dcaps.h)
export const D3DPSHADECAPS_COLORFLATMONO = 0x00000001;
export const D3DPSHADECAPS_COLORFLATRGB = 0x00000002;
export const D3DPSHADECAPS_COLORGOURAUDMONO = 0x00000004;
export const D3DPSHADECAPS_COLORGOURAUDRGB = 0x00000008;
export const D3DPSHADECAPS_COLORPHONGMONO = 0x00000010;
export const D3DPSHADECAPS_COLORPHONGRGB = 0x00000020;
export const D3DPSHADECAPS_SPECULARFLATMONO = 0x00000040;
export const D3DPSHADECAPS_SPECULARFLATRGB = 0x00000080;
export const D3DPSHADECAPS_SPECULARGOURAUDMONO = 0x00000100;
export const D3DPSHADECAPS_SPECULARGOURAUDRGB = 0x00000200;
export const D3DPSHADECAPS_SPECULARPHONGMONO = 0x00000400;
export const D3DPSHADECAPS_SPECULARPHONGRGB = 0x00000800;
export const D3DPSHADECAPS_ALPHAFLATBLEND = 0x00001000;
export const D3DPSHADECAPS_ALPHAFLATSTIPPLED = 0x00002000;
export const D3DPSHADECAPS_ALPHAGOURAUDBLEND = 0x00004000;
export const D3DPSHADECAPS_ALPHAGOURAUDSTIPPLED = 0x00008000;
export const D3DPSHADECAPS_ALPHAPHONGBLEND = 0x00010000;
export const D3DPSHADECAPS_ALPHAPHONGSTIPPLED = 0x00020000;
export const D3DPSHADECAPS_FOGFLAT = 0x00040000;
export const D3DPSHADECAPS_FOGGOURAUD = 0x00080000;
export const D3DPSHADECAPS_FOGPHONG = 0x00100000;

// D3DPRIMCAPS dwRasterCaps (d3dcaps.h + DX6/7 extensions)
export const D3DPRASTERCAPS_DITHER = 0x00000001;
export const D3DPRASTERCAPS_ROP2 = 0x00000002;
export const D3DPRASTERCAPS_XOR = 0x00000004;
export const D3DPRASTERCAPS_PAT = 0x00000008;
export const D3DPRASTERCAPS_ZTEST = 0x00000010;
export const D3DPRASTERCAPS_SUBPIXEL = 0x00000020;
export const D3DPRASTERCAPS_SUBPIXELX = 0x00000040;
export const D3DPRASTERCAPS_FOGVERTEX = 0x00000080;
export const D3DPRASTERCAPS_FOGTABLE = 0x00000100;
export const D3DPRASTERCAPS_STIPPLE = 0x00000200;
export const D3DPRASTERCAPS_ANTIALIASSORTINDEPENDENT = 0x00000800;
export const D3DPRASTERCAPS_ANTIALIASEDGES = 0x00001000;
export const D3DPRASTERCAPS_MIPMAPLODBIAS = 0x00002000;
export const D3DPRASTERCAPS_ZBIAS = 0x00004000;  // DX6+
export const D3DPRASTERCAPS_ZBUFFERLESSHSR = 0x00008000;
export const D3DPRASTERCAPS_FOGRANGE = 0x00010000;
export const D3DPRASTERCAPS_ANISOTROPY = 0x00020000;
export const D3DPRASTERCAPS_WBUFFER = 0x00040000;
export const D3DPRASTERCAPS_TRANSLUCENTSORTINDEPENDENT = 0x00080000;
export const D3DPRASTERCAPS_WFOG = 0x00100000;
export const D3DPRASTERCAPS_ZFOG = 0x00200000;

// D3DPRIMCAPS dwZCmpCaps / dwAlphaCmpCaps
export const D3DPCMPCAPS_NEVER = 0x00000001;
export const D3DPCMPCAPS_LESS = 0x00000002;
export const D3DPCMPCAPS_EQUAL = 0x00000004;
export const D3DPCMPCAPS_LESSEQUAL = 0x00000008;
export const D3DPCMPCAPS_GREATER = 0x00000010;
export const D3DPCMPCAPS_NOTEQUAL = 0x00000020;
export const D3DPCMPCAPS_GREATEREQUAL = 0x00000040;
export const D3DPCMPCAPS_ALWAYS = 0x00000080;

// D3DPRIMCAPS dwSrcBlendCaps / dwDestBlendCaps
export const D3DPBLENDCAPS_ZERO = 0x00000001;
export const D3DPBLENDCAPS_ONE = 0x00000002;
export const D3DPBLENDCAPS_SRCCOLOR = 0x00000004;
export const D3DPBLENDCAPS_INVSRCCOLOR = 0x00000008;
export const D3DPBLENDCAPS_SRCALPHA = 0x00000010;
export const D3DPBLENDCAPS_INVSRCALPHA = 0x00000020;
export const D3DPBLENDCAPS_DESTALPHA = 0x00000040;
export const D3DPBLENDCAPS_INVDESTALPHA = 0x00000080;
export const D3DPBLENDCAPS_DESTCOLOR = 0x00000100;
export const D3DPBLENDCAPS_INVDESTCOLOR = 0x00000200;
export const D3DPBLENDCAPS_SRCALPHASAT = 0x00000400;
export const D3DPBLENDCAPS_BOTHSRCALPHA = 0x00000800;
export const D3DPBLENDCAPS_BOTHINVSRCALPHA = 0x00001000;

// D3DFINDDEVICESEARCH dwFlags (d3dcaps.h)
export const D3DFDS_COLORMODEL = 0x00000001;
export const D3DFDS_GUID = 0x00000002;
export const D3DFDS_HARDWARE = 0x00000004;
export const D3DFDS_TRIANGLES = 0x00000008;
export const D3DFDS_LINES = 0x00000010;
export const D3DFDS_MISCCAPS = 0x00000020;
export const D3DFDS_RASTERCAPS = 0x00000040;
export const D3DFDS_ZCMPCAPS = 0x00000080;
export const D3DFDS_ALPHACMPCAPS = 0x00000100;
export const D3DFDS_SRCBLENDCAPS = 0x00000200;
export const D3DFDS_DSTBLENDCAPS = 0x00000400;
export const D3DFDS_SHADECAPS = 0x00000800;
export const D3DFDS_TEXTURECAPS = 0x00001000;
export const D3DFDS_TEXTUREFILTERCAPS = 0x00002000;
export const D3DFDS_TEXTUREBLENDCAPS = 0x00004000;
export const D3DFDS_TEXTUREADDRESSCAPS = 0x00008000;

// D3DEXECUTEBUFFERDESC dwFlags (d3dcaps.h)
export const D3DDEB_BUFSIZE = 0x00000001;
export const D3DDEB_CAPS = 0x00000002;
export const D3DDEB_LPDATA = 0x00000004;

// D3DEXECUTEBUFFERDESC dwCaps (d3dcaps.h)
export const D3DDEBCAPS_SYSTEMMEMORY = 0x00000001;
export const D3DDEBCAPS_VIDEOMEMORY = 0x00000002;
export const D3DDEBCAPS_MEM = D3DDEBCAPS_SYSTEMMEMORY | D3DDEBCAPS_VIDEOMEMORY;

// D3DDEVICEDESC structure offsets (DX6 layout, 252 bytes)
export const D3DDEVICEDESC_OFFSETS = {
    dwSize: 0,
    dwFlags: 4,
    dcmColorModel: 8,
    dwDevCaps: 12,
    dtcTransformCaps: 16,      // D3DTRANSFORMCAPS (8 bytes: dwSize + dwCaps)
    bClipping: 24,
    dlcLightingCaps: 28,       // D3DLIGHTINGCAPS (16 bytes)
    dpcLineCaps: 44,           // D3DPRIMCAPS (56 bytes)
    dpcTriCaps: 100,           // D3DPRIMCAPS (56 bytes)
    dwDeviceRenderBitDepth: 156,
    dwDeviceZBufferBitDepth: 160,
    dwMaxBufferSize: 164,
    dwMaxVertexCount: 168,
    dwMinTextureWidth: 172,
    dwMinTextureHeight: 176,
    dwMaxTextureWidth: 180,
    dwMaxTextureHeight: 184,
    // Stipple limits (DX6+; sit between MaxTextureHeight and MaxTextureRepeat)
    dwMinStippleWidth: 188,
    dwMaxStippleWidth: 192,
    dwMinStippleHeight: 196,
    dwMaxStippleHeight: 200,
    dwMaxTextureRepeat: 204,
    dwMaxTextureAspectRatio: 208,
    dwMaxAnisotropy: 212,
    dvGuardBandLeft: 216,
    dvGuardBandTop: 220,
    dvGuardBandRight: 224,
    dvGuardBandBottom: 228,
    dvExtentsAdjust: 232,
    dwStencilCaps: 236,
    dwFVFCaps: 240,
    dwTextureOpCaps: 244,
    wMaxTextureBlendStages: 248,
    wMaxSimultaneousTextures: 250,
};

// D3DPRIMCAPS structure offsets (56 bytes)
export const D3DPRIMCAPS_OFFSETS = {
    dwSize: 0,
    dwMiscCaps: 4,
    dwRasterCaps: 8,
    dwZCmpCaps: 12,
    dwSrcBlendCaps: 16,
    dwDestBlendCaps: 20,
    dwAlphaCmpCaps: 24,
    dwShadeCaps: 28,
    dwTextureCaps: 32,
    dwTextureFilterCaps: 36,
    dwTextureBlendCaps: 40,
    dwTextureAddressCaps: 44,
    dwStippleWidth: 48,
    dwStippleHeight: 52,
};

// Default capability values for emulated D3D HAL device
export const EMU_D3D_DEFAULT_CAPS = {
    // dwFlags - only fields we actually fill (avoids games interpreting unset bits as "valid and zero")
    dwFlags:
        D3DDD_COLORMODEL |
        D3DDD_DEVCAPS |
        D3DDD_TRANSFORMCAPS |
        D3DDD_LIGHTINGCAPS |
        D3DDD_BCLIPPING |
        D3DDD_LINECAPS |
        D3DDD_TRICAPS |
        D3DDD_DEVICERENDERBITDEPTH |
        D3DDD_DEVICEZBUFFERBITDEPTH |
        D3DDD_MAXBUFFERSIZE |
        D3DDD_MAXVERTEXCOUNT,

    // dwDevCaps — matches real HW (0x000BBEF1 for known DX6/7 flags)
    dwDevCaps:
        D3DDEVCAPS_FLOATTLVERTEX |
        D3DDEVCAPS_EXECUTESYSTEMMEMORY |
        D3DDEVCAPS_EXECUTEVIDEOMEMORY |
        D3DDEVCAPS_TLVERTEXSYSTEMMEMORY |
        D3DDEVCAPS_TLVERTEXVIDEOMEMORY |
        D3DDEVCAPS_TEXTURESYSTEMMEMORY |
        D3DDEVCAPS_TEXTUREVIDEOMEMORY |
        D3DDEVCAPS_TEXTURENONLOCALVIDMEM |
        D3DDEVCAPS_DRAWPRIMTLVERTEX |
        D3DDEVCAPS_CANRENDERAFTERFLIP |
        D3DDEVCAPS_DRAWPRIMITIVES2 |
        D3DDEVCAPS_DRAWPRIMITIVES2EX |
        D3DDEVCAPS_HWTRANSFORMANDLIGHT |
        D3DDEVCAPS_CANBLTSYSTONONLOCAL |
        D3DDEVCAPS_HWRASTERIZATION,

    // dpcTriCaps.dwTextureCaps — matches real HW
    // Note: POW2 intentionally NOT set — real HW doesn't require power-of-two textures
    // COLORKEYBLEND needed for games that check it before enabling colorkey in 3D pipeline
    dwTextureCaps:
        D3DPTEXTURECAPS_PERSPECTIVE |
        D3DPTEXTURECAPS_ALPHA |
        D3DPTEXTURECAPS_TRANSPARENCY |
        D3DPTEXTURECAPS_TEXREPEATNOTSCALEDBYSIZE |
        D3DPTEXTURECAPS_ALPHAPALETTE |
        D3DPTEXTURECAPS_PROJECTED |
        D3DPTEXTURECAPS_CUBEMAP |
        D3DPTEXTURECAPS_COLORKEYBLEND,

    // dpcTriCaps.dwTextureFilterCaps — matches real HW (0x0303073F)
    dwTextureFilterCaps:
        D3DPTFILTERCAPS_NEAREST |
        D3DPTFILTERCAPS_LINEAR |
        D3DPTFILTERCAPS_MIPNEAREST |
        D3DPTFILTERCAPS_MIPLINEAR |
        D3DPTFILTERCAPS_LINEARMIPNEAREST |
        D3DPTFILTERCAPS_LINEARMIPLINEAR |
        D3DPTFILTERCAPS_MINFPOINT |
        D3DPTFILTERCAPS_MINFLINEAR |
        D3DPTFILTERCAPS_MINFANISOTROPIC |
        D3DPTFILTERCAPS_MIPFPOINT |
        D3DPTFILTERCAPS_MIPFLINEAR |
        D3DPTFILTERCAPS_MAGFPOINT |
        D3DPTFILTERCAPS_MAGFLINEAR,

    // dpcTriCaps.dwTextureBlendCaps — matches real HW (0xCF)
    dwTextureBlendCaps:
        D3DPTBLENDCAPS_DECAL |
        D3DPTBLENDCAPS_MODULATE |
        D3DPTBLENDCAPS_DECALALPHA |
        D3DPTBLENDCAPS_MODULATEALPHA |
        D3DPTBLENDCAPS_ADD |
        D3DPTBLENDCAPS_COPY,

    // dpcTriCaps.dwTextureAddressCaps
    dwTextureAddressCaps:
        D3DPTADDRESSCAPS_WRAP |
        D3DPTADDRESSCAPS_MIRROR |
        D3DPTADDRESSCAPS_CLAMP,

    // dpcTriCaps.dwShadeCaps — matches real HW (0x0C528F)
    dwShadeCaps:
        D3DPSHADECAPS_COLORFLATMONO |
        D3DPSHADECAPS_COLORFLATRGB |
        D3DPSHADECAPS_COLORGOURAUDMONO |
        D3DPSHADECAPS_COLORGOURAUDRGB |
        D3DPSHADECAPS_SPECULARFLATRGB |
        D3DPSHADECAPS_SPECULARGOURAUDRGB |
        D3DPSHADECAPS_ALPHAFLATBLEND |
        D3DPSHADECAPS_ALPHAGOURAUDBLEND |
        D3DPSHADECAPS_FOGFLAT |
        D3DPSHADECAPS_FOGGOURAUD,

    // dpcTriCaps.dwRasterCaps — matches real HW (0x3379B1)
    dwRasterCaps:
        D3DPRASTERCAPS_DITHER |
        D3DPRASTERCAPS_ZTEST |
        D3DPRASTERCAPS_SUBPIXEL |
        D3DPRASTERCAPS_FOGVERTEX |
        D3DPRASTERCAPS_FOGTABLE |
        D3DPRASTERCAPS_ANTIALIASSORTINDEPENDENT |
        D3DPRASTERCAPS_ANTIALIASEDGES |
        D3DPRASTERCAPS_MIPMAPLODBIAS |
        D3DPRASTERCAPS_ZBIAS |
        D3DPRASTERCAPS_FOGRANGE |
        D3DPRASTERCAPS_ANISOTROPY |
        D3DPRASTERCAPS_WFOG |
        D3DPRASTERCAPS_ZFOG,

    // dpcTriCaps.dwZCmpCaps
    dwZCmpCaps:
        D3DPCMPCAPS_NEVER |
        D3DPCMPCAPS_LESS |
        D3DPCMPCAPS_EQUAL |
        D3DPCMPCAPS_LESSEQUAL |
        D3DPCMPCAPS_GREATER |
        D3DPCMPCAPS_NOTEQUAL |
        D3DPCMPCAPS_GREATEREQUAL |
        D3DPCMPCAPS_ALWAYS,

    // dpcTriCaps.dwAlphaCmpCaps
    dwAlphaCmpCaps:
        D3DPCMPCAPS_NEVER |
        D3DPCMPCAPS_LESS |
        D3DPCMPCAPS_EQUAL |
        D3DPCMPCAPS_LESSEQUAL |
        D3DPCMPCAPS_GREATER |
        D3DPCMPCAPS_NOTEQUAL |
        D3DPCMPCAPS_GREATEREQUAL |
        D3DPCMPCAPS_ALWAYS,

    // dwStencilCaps - stencil comparison capabilities (same as Z comparison caps)
    dwStencilCaps:
        D3DPCMPCAPS_NEVER |
        D3DPCMPCAPS_LESS |
        D3DPCMPCAPS_EQUAL |
        D3DPCMPCAPS_LESSEQUAL |
        D3DPCMPCAPS_GREATER |
        D3DPCMPCAPS_NOTEQUAL |
        D3DPCMPCAPS_GREATEREQUAL |
        D3DPCMPCAPS_ALWAYS,

    // dpcTriCaps.dwSrcBlendCaps / dwDestBlendCaps — matches real HW (0x1FFF)
    dwBlendCaps:
        D3DPBLENDCAPS_ZERO |
        D3DPBLENDCAPS_ONE |
        D3DPBLENDCAPS_SRCCOLOR |
        D3DPBLENDCAPS_INVSRCCOLOR |
        D3DPBLENDCAPS_SRCALPHA |
        D3DPBLENDCAPS_INVSRCALPHA |
        D3DPBLENDCAPS_DESTALPHA |
        D3DPBLENDCAPS_INVDESTALPHA |
        D3DPBLENDCAPS_DESTCOLOR |
        D3DPBLENDCAPS_INVDESTCOLOR |
        D3DPBLENDCAPS_SRCALPHASAT |
        D3DPBLENDCAPS_BOTHSRCALPHA |
        D3DPBLENDCAPS_BOTHINVSRCALPHA,

    // Texture size limits
    dwMinTextureWidth: 1,
    dwMinTextureHeight: 1,
    dwMaxTextureWidth: 2048,
    dwMaxTextureHeight: 2048,
    dwMaxTextureRepeat: 2048,
    dwMaxTextureAspectRatio: 2048,
    dwMaxAnisotropy: 16,

    // Vertex limits
    dwMaxBufferSize: 0,
    dwMaxVertexCount: 65535,

    // Texture stages
    wMaxTextureBlendStages: 8,
    wMaxSimultaneousTextures: 8,
};

// Video DLL support: when false (default), binkw32/smackw32 are handled by HLE stubs
// (videos are gracefully skipped). Set true only if native x86 video DLLs are available
// and functional.
export const EMU_NATIVE_VIDEO_DLLS = false;

// Names of video codec DLLs that are intercepted by HLE stubs when EMU_NATIVE_VIDEO_DLLS=false
export const VIDEO_DLL_NAMES = new Set(['smackw32', 'binkw32', 'lgvid']);

// Default DDCAPS values — matches real HW (0x85D007C1)
export const EMU_DDRAW_DEFAULT_CAPS = {
    dwCaps:
        DDCAPS_3D |
        DDCAPS_BLT |
        DDCAPS_BLTQUEUE |
        DDCAPS_BLTFOURCC |
        DDCAPS_BLTSTRETCH |
        DDCAPS_GDI |
        DDCAPS_ZBLTS |
        DDCAPS_COLORKEY |
        DDCAPS_ALPHA |
        DDCAPS_COLORKEYHWASSIST |
        DDCAPS_BLTCOLORFILL |
        DDCAPS_CANBLTSYSMEM,
    dwCaps2:
        DDCAPS2_CERTIFIED |
        DDCAPS2_NO2DDURING3DSCENE |
        DDCAPS2_CANMANAGETEXTURE |
        DDCAPS2_TEXMANINNONLOCALVIDMEM |
        DDCAPS2_PRIMARYGAMMA |
        DDCAPS2_CANRENDERWINDOWED,
    dwVidMemTotal: 64 * 1024 * 1024,
    dwVidMemFree: 48 * 1024 * 1024,
};
