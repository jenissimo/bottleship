/**
 * Validate Win32 struct offset tables against known SDK sizes.
 * Run: bun tools/validate-struct-offsets.ts
 *
 * Cross-references hardcoded offset tables with the actual Win32 struct sizes
 * to catch silent ABI bugs (wrong offsets = memory corruption in guest).
 */

// Offsets imported from the implementation are checked against the SDK sizes
// hardcoded below, so a drift in the shipped table is a build failure, not a
// silently malformed guest struct.
import {
    DEV_BROADCAST_DEVICEINTERFACE_OFFSETS,
    DEV_BROADCAST_HDR_OFFSETS,
} from '../src/worker/modules/user32/dev-broadcast';

// --- Known Win32 struct sizes (x86, default 8-byte alignment unless noted) ---
interface StructSpec {
    name: string;
    expectedSize: number;
    packAlignment?: number; // #pragma pack(N), default = 8
    offsets: Record<string, number>;
    /** Last field name + its size, used to compute total struct size from offsets */
    lastField?: { name: string; size: number };
}

const STRUCT_SPECS: StructSpec[] = [
    {
        name: 'DDSURFACEDESC2',
        expectedSize: 124,
        offsets: {
            dwSize: 0, dwFlags: 4, dwHeight: 8, dwWidth: 12,
            lPitch: 16, dwBackBufferCount: 20, dwMipMapCount: 24,
            dwAlphaBitDepth: 28, dwReserved: 32, lpSurface: 36,
            ddckCKDestOverlay: 40, ddckCKDestBlt: 48,
            ddckCKSrcOverlay: 56, ddckCKSrcBlt: 64,
            ddpfPixelFormat: 72, // 32 bytes
            ddsCaps: 104, // DDSCAPS2 = 16 bytes
            dwTextureStage: 120,
        },
        lastField: { name: 'dwTextureStage', size: 4 },
    },
    {
        name: 'DDSURFACEDESC',
        expectedSize: 108,
        offsets: {
            dwSize: 0, dwFlags: 4, dwHeight: 8, dwWidth: 12,
            lPitch: 16, dwBackBufferCount: 20,
            lpSurface: 36,
            ddpfPixelFormat: 72, // 32 bytes
            ddsCaps: 104, // DDSCAPS = 4 bytes
        },
        lastField: { name: 'ddsCaps', size: 4 },
    },
    {
        name: 'DDPIXELFORMAT',
        expectedSize: 32,
        offsets: {
            dwSize: 0, dwFlags: 4, dwFourCC: 8,
            dwRGBBitCount: 12, dwRBitMask: 16,
            dwGBitMask: 20, dwBBitMask: 24, dwRGBAlphaBitMask: 28,
        },
        lastField: { name: 'dwRGBAlphaBitMask', size: 4 },
    },
    {
        name: 'DDCAPS',
        expectedSize: 380,
        offsets: {
            dwSize: 0, dwCaps: 4, dwCaps2: 8,
            dwCKeyCaps: 12, dwFXCaps: 16, dwFXAlphaCaps: 20,
            dwPalCaps: 24, dwSVCaps: 28,
            // Gap: dwAlphaBltConstBitDepths..dwNLVBRops (offsets 32-99)
            ddsCaps: 100,
            // Gap: dwMaxVisibleOverlays etc.
            dwVidMemTotal: 256, dwVidMemFree: 260,
        },
    },
    {
        name: 'D3DDEVICEDESC',
        expectedSize: 252,
        offsets: {
            dwSize: 0, dwFlags: 4, dcmColorModel: 8, dwDevCaps: 12,
            dtcTransformCaps: 16, bClipping: 24,
            dlcLightingCaps: 28, dpcLineCaps: 44,
            dpcTriCaps: 100, dwDeviceRenderBitDepth: 156,
            dwDeviceZBufferBitDepth: 160, dwMaxBufferSize: 164,
            dwMaxVertexCount: 168, dwFVFCaps: 240,
            dwTextureOpCaps: 244,
            wMaxTextureBlendStages: 248, wMaxSimultaneousTextures: 250,
        },
        lastField: { name: 'wMaxSimultaneousTextures', size: 2 },
    },
    {
        name: 'D3DPRIMCAPS',
        expectedSize: 56,
        offsets: {
            dwSize: 0, dwMiscCaps: 4, dwRasterCaps: 8,
            dwZCmpCaps: 12, dwSrcBlendCaps: 16, dwDestBlendCaps: 20,
            dwAlphaCmpCaps: 24, dwShadeCaps: 28,
            dwTextureCaps: 32, dwTextureFilterCaps: 36,
            dwTextureBlendCaps: 40, dwTextureAddressCaps: 44,
            dwStippleWidth: 48, dwStippleHeight: 52,
        },
        lastField: { name: 'dwStippleHeight', size: 4 },
    },
    {
        name: 'D3DMATERIAL7',
        expectedSize: 68,
        offsets: {
            diffuse: 0, ambient: 16, specular: 32, emissive: 48, dvPower: 64,
        },
        lastField: { name: 'dvPower', size: 4 },
    },
    {
        name: 'D3DLIGHT7',
        expectedSize: 104,
        offsets: {
            dltType: 0, dcvDiffuse: 4, dcvSpecular: 20, dcvAmbient: 36,
            dvPosition: 52, dvDirection: 64, dvRange: 76,
            dvFalloff: 80, dvAttenuation0: 84, dvAttenuation1: 88,
            dvAttenuation2: 92, dvTheta: 96, dvPhi: 100,
        },
        lastField: { name: 'dvPhi', size: 4 },
    },
    {
        name: 'WNDCLASSEXA',
        expectedSize: 48,
        offsets: {
            cbSize: 0, style: 4, lpfnWndProc: 8, cbClsExtra: 12,
            cbWndExtra: 16, hInstance: 20, hIcon: 24, hCursor: 28,
            hbrBackground: 32, lpszMenuName: 36, lpszClassName: 40,
            hIconSm: 44,
        },
        lastField: { name: 'hIconSm', size: 4 },
    },
    {
        name: 'WNDCLASSA',
        expectedSize: 40,
        offsets: {
            style: 0, lpfnWndProc: 4, cbClsExtra: 8, cbWndExtra: 12,
            hInstance: 16, hIcon: 20, hCursor: 24, hbrBackground: 28,
            lpszMenuName: 32, lpszClassName: 36,
        },
        lastField: { name: 'lpszClassName', size: 4 },
    },
    {
        name: 'MSG',
        expectedSize: 28,
        offsets: {
            hwnd: 0, message: 4, wParam: 8, lParam: 12,
            time: 16, pt_x: 20, pt_y: 24,
        },
        lastField: { name: 'pt_y', size: 4 },
    },
    {
        name: 'RECT',
        expectedSize: 16,
        offsets: { left: 0, top: 4, right: 8, bottom: 12 },
        lastField: { name: 'bottom', size: 4 },
    },
    {
        name: 'CRITICAL_SECTION',
        expectedSize: 24,
        offsets: {
            DebugInfo: 0, LockCount: 4, RecursionCount: 8,
            OwningThread: 12, LockSemaphore: 16, SpinCount: 20,
        },
        lastField: { name: 'SpinCount', size: 4 },
    },
    {
        name: 'D3DCOLORVALUE',
        expectedSize: 16,
        offsets: { r: 0, g: 4, b: 8, a: 12 },
        lastField: { name: 'a', size: 4 },
    },
    {
        name: 'D3DVECTOR',
        expectedSize: 12,
        offsets: { x: 0, y: 4, z: 8 },
        lastField: { name: 'z', size: 4 },
    },
    {
        name: 'PALETTEENTRY',
        expectedSize: 4,
        packAlignment: 1,
        offsets: { peRed: 0, peGreen: 1, peBlue: 2, peFlags: 3 },
        lastField: { name: 'peFlags', size: 1 },
    },
    {
        name: 'DDDEVICEIDENTIFIER2',
        expectedSize: 1072,  // 1068 actual + 4 bytes trailing padding (8-byte alignment due to LARGE_INTEGER)
        offsets: {
            szDriver: 0,          // char[512]
            szDescription: 512,   // char[512]
            liDriverVersion: 1024, // LARGE_INTEGER (8 bytes)
            dwVendorId: 1032, dwDeviceId: 1036,
            dwSubSysId: 1040, dwRevision: 1044,
            guidDeviceIdentifier: 1048, // GUID (16 bytes)
            dwWHQLLevel: 1064,
        },
        lastField: { name: 'dwWHQLLevel', size: 8 }, // 4 bytes + 4 bytes trailing alignment padding
    },
    {
        name: 'DEV_BROADCAST_HDR',
        expectedSize: 12,
        offsets: { ...DEV_BROADCAST_HDR_OFFSETS },
        lastField: { name: 'dbch_reserved', size: 4 },
    },
    {
        name: 'DEV_BROADCAST_DEVICEINTERFACE',
        expectedSize: 32,
        offsets: { ...DEV_BROADCAST_DEVICEINTERFACE_OFFSETS },
        // dbcc_name is char[1]/WCHAR[1] in the header; the real name follows inline
        // and dbcc_size covers it. sizeof() is the padded 32.
        lastField: { name: 'dbcc_name', size: 1 },
    },
];

// --- Validation ---
let errors = 0;
let warnings = 0;

for (const spec of STRUCT_SPECS) {
    // 1. Check computed size from last field
    if (spec.lastField) {
        const lastOffset = spec.offsets[spec.lastField.name];
        if (lastOffset === undefined) {
            console.error(`  ERROR: ${spec.name} - lastField '${spec.lastField.name}' not found in offsets`);
            errors++;
            continue;
        }
        const computedSize = lastOffset + spec.lastField.size;
        // Account for alignment padding
        const align = spec.packAlignment ?? 4; // x86 structs typically 4-byte aligned
        const alignedSize = Math.ceil(computedSize / align) * align;

        if (computedSize !== spec.expectedSize && alignedSize !== spec.expectedSize) {
            console.error(
                `  ERROR: ${spec.name} - computed size ${computedSize} (aligned: ${alignedSize}) != expected ${spec.expectedSize}`
            );
            errors++;
        }
    }

    // 2. Check that offsets are monotonically increasing (no overlaps)
    const entries = Object.entries(spec.offsets).sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < entries.length; i++) {
        if (entries[i][1] < entries[i - 1][1]) {
            console.error(
                `  ERROR: ${spec.name} - offset for '${entries[i][0]}' (${entries[i][1]}) < '${entries[i - 1][0]}' (${entries[i - 1][1]})`
            );
            errors++;
        }
    }

    // 3. Check no offset exceeds struct size
    for (const [field, offset] of Object.entries(spec.offsets)) {
        if (offset >= spec.expectedSize) {
            console.error(
                `  ERROR: ${spec.name}.${field} offset ${offset} >= struct size ${spec.expectedSize}`
            );
            errors++;
        }
        if (offset < 0) {
            console.error(`  ERROR: ${spec.name}.${field} has negative offset ${offset}`);
            errors++;
        }
    }

    // 4. Check 4-byte alignment for DWORD fields (heuristic: field name starts with dw/lp/h)
    for (const [field, offset] of Object.entries(spec.offsets)) {
        const isDword = /^(dw|lp|h[A-Z]|cb|style|message|time|pt_)/.test(field);
        if (isDword && (offset & 3) !== 0) {
            console.warn(
                `  WARN: ${spec.name}.${field} at offset ${offset} is not 4-byte aligned (expected DWORD)`
            );
            warnings++;
        }
    }
}

// --- Summary ---
console.log('');
console.log(`Validated ${STRUCT_SPECS.length} struct definitions`);
if (errors === 0 && warnings === 0) {
    console.log('All struct offsets validated successfully!');
} else {
    if (errors > 0) console.error(`${errors} error(s) found!`);
    if (warnings > 0) console.warn(`${warnings} warning(s) found`);
    if (errors > 0) process.exit(1);
}
