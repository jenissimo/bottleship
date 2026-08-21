/**
 * Shared D3D capability utilities.
 * fillDeviceDesc fills D3DDEVICEDESC structures for both EnumDevices (IDirect3D3)
 * and GetCaps (IDirect3DDevice3) paths.
 */
import { Logger, LogCategory } from "../../../core/logger";
import {
    DDBD_16,
    DDBD_32,
    D3DPMISCCAPS_MASKZ,
    D3DPMISCCAPS_CULLNONE,
    D3DPMISCCAPS_CULLCW,
    D3DPMISCCAPS_CULLCCW,
} from "../constants";
import {
    D3DDEVICEDESC_OFFSETS,
    D3DPRIMCAPS_OFFSETS,
    D3DTRANSFORMCAPS_CLIP,
    D3DLIGHTINGMODEL_RGB,
    D3DLIGHTINGMODEL_MONO,
    D3DLIGHTCAPS_POINT,
    D3DLIGHTCAPS_SPOT,
    D3DLIGHTCAPS_DIRECTIONAL,
    D3DLIGHTCAPS_PARALLELPOINT,
    D3DLIGHTCAPS_GLSPOT,
    D3DDEVCAPS_EXECUTEVIDEOMEMORY,
    D3DDEVCAPS_TLVERTEXVIDEOMEMORY,
    D3DDEVCAPS_TEXTUREVIDEOMEMORY,
    D3DDEVCAPS_TEXTURENONLOCALVIDMEM,
    D3DDEVCAPS_HWTRANSFORMANDLIGHT,
    D3DDEVCAPS_CANBLTSYSTONONLOCAL,
    D3DDEVCAPS_HWRASTERIZATION,
} from "../../../core/cpu/emulator-config";
import { EmulatorConfig } from "../../../core/emulator-config-manager";

/**
 * Bit depths reported for render targets and depth buffers alike. Both lists are the same
 * because both are bounded by what we actually serve: EnumDisplayModes offers 16 and 32 bpp,
 * and EnumZBufferFormats offers D16 / D24X8 / D24S8 — the last two being 32 TOTAL bits, which
 * is how every real driver reports a 24-bit depth buffer. Nothing anywhere produces a surface
 * of 24 total bits, so DDBD_24 was a bit no code held.
 */
export const zBufferMask = DDBD_16 | DDBD_32;

/**
 * D3DPRIMCAPS.dwMiscCaps — only what the ddraw pipeline actually implements:
 *   MASKZ    — D3DRENDERSTATE_ZWRITEENABLE reaches depthWriteEnabled (d3d/draw-handler.ts).
 *   CULLNONE/CULLCW/CULLCCW — D3DRENDERSTATE_CULLMODE maps to a GPUCullMode in
 *                             backends/webgpu/ddraw/pipeline-factory.ts, all three values.
 * NOT MASKPLANES: there is no per-channel colour write mask on this path.
 * NOT LINEPATTERNREP, NOT CONFORMANT.
 */
const D3D_PRIMCAPS_MISC =
    D3DPMISCCAPS_MASKZ | D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW;

/**
 * dwTextureOpCaps — the D3DTOP values applyColorOp/applyAlphaOp really evaluate
 * (backends/webgpu/ddraw/shader-generator.ts). DISABLE..SUBTRACT is contiguous (0x3ff), and
 * the three alpha blends sit above ADDSMOOTH, which has no WGSL body and is therefore absent.
 * Everything from BLENDTEXTUREALPHAPM up (premultiplied, MODULATE*_ADD*, bump env, DOTPRODUCT3)
 * is unimplemented and stays unclaimed.
 */
const D3D_TEXTURE_OP_CAPS =
    0x000003ff |  // DISABLE, SELECTARG1/2, MODULATE/2X/4X, ADD, ADDSIGNED/2X, SUBTRACT
    0x00000800 |  // BLENDDIFFUSEALPHA
    0x00001000 |  // BLENDTEXTUREALPHA
    0x00002000;   // BLENDFACTORALPHA
export const D3DDEVICEDESC7_SIZE = 236;

// IID_IDirect3DRGBDevice = {A4665C60-2673-11CF-A31A-00AA00B93356}
export const D3D7_RGB_DEVICE_GUID_BYTES = [
    0x60, 0x5c, 0x66, 0xa4, 0x73, 0x26, 0xcf, 0x11, 0xa3, 0x1a, 0x00, 0xaa, 0x00, 0xb9, 0x33, 0x56,
];

// IID_IDirect3DHALDevice = {84E63DE0-46AA-11CF-816F-0000C020156E}
export const D3D7_HAL_DEVICE_GUID_BYTES = [
    0xe0, 0x3d, 0xe6, 0x84, 0xaa, 0x46, 0xcf, 0x11, 0x81, 0x6f, 0x00, 0x00, 0xc0, 0x20, 0x15, 0x6e,
];

// IID_IDirect3DTnLHalDevice = {F5049E78-4861-11D2-A407-00A0C90629A8} (DX7-only)
export const D3D7_TNLHAL_DEVICE_GUID_BYTES = [
    0x78, 0x9e, 0x04, 0xf5, 0x61, 0x48, 0xd2, 0x11, 0xa4, 0x07, 0x00, 0xa0, 0xc9, 0x06, 0x29, 0xa8,
];

/**
 * DX7 device identity. Faithful to a T&L-era card, three devices are enumerated and their
 * D3DDEVICEDESC7.dwDevCaps differ per device:
 *   rgb    — software rasterizer: no HW-only bits at all;
 *   hal    — HW rasterization, but T&L done by the runtime: NO HWTRANSFORMANDLIGHT;
 *   tnlhal — HW rasterization + HWTRANSFORMANDLIGHT (the "T&L HAL" device).
 * Engines pick their vertex pipeline off this split (own CPU transform vs D3D T&L), so
 * collapsing it (old behavior: HWTNL on everything, no TnLHal device) pushed GUID-seeking
 * engines onto their guest CPU-transform path.
 * A/B kill switch: harness `setWorkerFlag('__caps7Legacy', true)` BEFORE game load restores
 * the old uniform-caps/two-device behavior (engines read caps once at device init).
 */
export type D3d7DeviceKind = "rgb" | "hal" | "tnlhal";

const guidBytesEqual = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
    for (let i = 0; i < 16; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return false;
    return true;
};

export const d3d7DeviceKindForGuidBytes = (guid: ReadonlyArray<number>): D3d7DeviceKind => {
    if (guidBytesEqual(guid, D3D7_RGB_DEVICE_GUID_BYTES)) return "rgb";
    if (guidBytesEqual(guid, D3D7_TNLHAL_DEVICE_GUID_BYTES)) return "tnlhal";
    return "hal";
};

export const d3d7DeviceGuidForKind = (kind: D3d7DeviceKind): ReadonlyArray<number> =>
    kind === "rgb" ? D3D7_RGB_DEVICE_GUID_BYTES
    : kind === "tnlhal" ? D3D7_TNLHAL_DEVICE_GUID_BYTES
    : D3D7_HAL_DEVICE_GUID_BYTES;

/** dwDevCaps bits only a hardware device may claim — stripped for software devices. */
const DEVCAPS_HW_ONLY_MASK =
    D3DDEVCAPS_EXECUTEVIDEOMEMORY |
    D3DDEVCAPS_TLVERTEXVIDEOMEMORY |
    D3DDEVCAPS_TEXTUREVIDEOMEMORY |
    D3DDEVCAPS_TEXTURENONLOCALVIDMEM |
    D3DDEVCAPS_HWTRANSFORMANDLIGHT |
    D3DDEVCAPS_CANBLTSYSTONONLOCAL |
    D3DDEVCAPS_HWRASTERIZATION;

export const d3d7DevCapsForKind = (kind: D3d7DeviceKind, baseDevCaps: number): number => {
    if (kind === "rgb") return (baseDevCaps & ~DEVCAPS_HW_ONLY_MASK) >>> 0;
    if (kind === "hal") return (baseDevCaps & ~D3DDEVCAPS_HWTRANSFORMANDLIGHT) >>> 0;
    return (baseDevCaps | D3DDEVCAPS_HWTRANSFORMANDLIGHT) >>> 0;
};

/**
 * D3DDEVICEDESC7.dwVertexProcessingCaps: TEXGEN | MATERIALSOURCE7 | DIRECTIONALLIGHTS |
 * POSITIONALLIGHTS | LOCALVIEWER — exactly what our shared FFP implements; matches the
 * D3D8 caps value (d3d8/caps.ts offset 156). No VERTEXFOG (0x04) — consistent with D3D8.
 */
const D3D7_VERTEX_PROCESSING_CAPS = 0x0000003b;

const isCaps7Legacy = (): boolean =>
    (globalThis as Record<string, unknown>).__caps7Legacy === true;

/**
 * Fill D3DDEVICEDESC structure with proper capability flags.
 * This is critical for games to detect texture support (including colorkey transparency).
 * Note: addr is not checked for 4-byte alignment; DataView handles unaligned access, which is acceptable for HLE.
 * `software` = fill as a software (HEL/RGB) desc: HW-only dwDevCaps bits are stripped —
 * a software rasterizer claiming HWRASTERIZATION/video-memory execution is a caps lie.
 */
export const fillDeviceDesc = (view: DataView, addr: number, software = false): void => {
    if (!addr || addr < 0x10000) return;
    if (addr + 4 > view.byteLength) return;

    let size = view.getUint32(addr, true);
    // Caller should pre-set dwSize to 172 (DX5) or 252 (DX6).
    // If invalid (e.g. uninitialized stack memory), default to DX6 size and fix it up.
    if (size < 16 || size > 1024) {
        Logger.warn(LogCategory.DDRAW,
            `[COLORKEY] fillDeviceDesc: bad dwSize=${size} at 0x${addr.toString(16)}, forcing 252 (DX6)`);
        size = 252;
        view.setUint32(addr, size, true);
    }
    if (addr + size > view.byteLength) return;

    // Use caps from emulator config (may be overridden by manifest)
    const emulatorConfig = EmulatorConfig.getInstance();
    const caps = emulatorConfig.d3dCaps;
    const descOff = D3DDEVICEDESC_OFFSETS;
    const primOff = D3DPRIMCAPS_OFFSETS;

    // Log capabilities for colorkey diagnostics
    Logger.log(LogCategory.DDRAW,
        `[COLORKEY] fillDeviceDesc: addr=0x${addr.toString(16)} size=${size} dwFlags=0x${caps.dwFlags.toString(16)} dwTextureCaps=0x${caps.dwTextureCaps.toString(16)} dwRasterCaps=0x${caps.dwRasterCaps.toString(16)}`);

    const write32 = (offset: number, value: number) => {
        if (size > offset) view.setUint32(addr + offset, value, true);
    };
    const write16 = (offset: number, value: number) => {
        if (size > offset) view.setUint16(addr + offset, value, true);
    };

    // Basic header
    write32(descOff.dwSize, size);
    write32(descOff.dwFlags, caps.dwFlags);
    write32(descOff.dcmColorModel, 2); // D3DCOLOR_RGB
    write32(descOff.dwDevCaps, software && !isCaps7Legacy()
        ? d3d7DevCapsForKind("rgb", caps.dwDevCaps)
        : caps.dwDevCaps);

    // D3DTRANSFORMCAPS
    write32(descOff.dtcTransformCaps, 8);
    write32(descOff.dtcTransformCaps + 4, D3DTRANSFORMCAPS_CLIP);

    // bClipping
    write32(descOff.bClipping, 1);

    // D3DLIGHTINGCAPS
    const dlcCaps = D3DLIGHTCAPS_POINT | D3DLIGHTCAPS_SPOT | D3DLIGHTCAPS_DIRECTIONAL | D3DLIGHTCAPS_PARALLELPOINT | D3DLIGHTCAPS_GLSPOT;
    const dlcModel = D3DLIGHTINGMODEL_RGB | D3DLIGHTINGMODEL_MONO;
    write32(descOff.dlcLightingCaps, 16);
    write32(descOff.dlcLightingCaps + 4, dlcCaps);
    write32(descOff.dlcLightingCaps + 8, dlcModel);
    write32(descOff.dlcLightingCaps + 12, 8); // dwNumLights

    // Fill D3DPRIMCAPS
    const fillPrimCaps = (baseOffset: number, name: string) => {
        write32(baseOffset + primOff.dwSize, 56);
        write32(baseOffset + primOff.dwMiscCaps, D3D_PRIMCAPS_MISC);
        write32(baseOffset + primOff.dwRasterCaps, caps.dwRasterCaps);
        write32(baseOffset + primOff.dwZCmpCaps, caps.dwZCmpCaps);
        write32(baseOffset + primOff.dwSrcBlendCaps, caps.dwBlendCaps);
        write32(baseOffset + primOff.dwDestBlendCaps, caps.dwBlendCaps);
        write32(baseOffset + primOff.dwAlphaCmpCaps, caps.dwAlphaCmpCaps);
        write32(baseOffset + primOff.dwShadeCaps, caps.dwShadeCaps);
        write32(baseOffset + primOff.dwTextureCaps, caps.dwTextureCaps);
        write32(baseOffset + primOff.dwTextureFilterCaps, caps.dwTextureFilterCaps);
        write32(baseOffset + primOff.dwTextureBlendCaps, caps.dwTextureBlendCaps);
        write32(baseOffset + primOff.dwTextureAddressCaps, caps.dwTextureAddressCaps);
        write32(baseOffset + primOff.dwStippleWidth, 32);
        write32(baseOffset + primOff.dwStippleHeight, 32);

        // Verify the textureCaps offset is writable
        Logger.log(LogCategory.DDRAW,
            `[COLORKEY] fillPrimCaps(${name}): writing dwTextureCaps=0x${caps.dwTextureCaps.toString(16)} at offset ${baseOffset + primOff.dwTextureCaps}`);
    };

    fillPrimCaps(descOff.dpcLineCaps, "dpcLineCaps");
    fillPrimCaps(descOff.dpcTriCaps, "dpcTriCaps");

    // Render/Z-buffer bit depths
    write32(descOff.dwDeviceRenderBitDepth, zBufferMask);
    write32(descOff.dwDeviceZBufferBitDepth, zBufferMask);

    // Buffer/vertex limits
    write32(descOff.dwMaxBufferSize, caps.dwMaxBufferSize);
    write32(descOff.dwMaxVertexCount, caps.dwMaxVertexCount);

    // Texture size limits
    write32(descOff.dwMinTextureWidth, caps.dwMinTextureWidth);
    write32(descOff.dwMinTextureHeight, caps.dwMinTextureHeight);
    write32(descOff.dwMaxTextureWidth, caps.dwMaxTextureWidth);
    write32(descOff.dwMaxTextureHeight, caps.dwMaxTextureHeight);
    // Stipple limits (DX6+; sit between MaxTextureHeight and MaxTextureRepeat)
    if ("dwMinStippleWidth" in descOff) {
        write32(descOff.dwMinStippleWidth, 1);
        write32(descOff.dwMinStippleHeight, 1);
        write32(descOff.dwMaxStippleWidth, 32);
        write32(descOff.dwMaxStippleHeight, 32);
    }
    write32(descOff.dwMaxTextureRepeat, caps.dwMaxTextureRepeat);
    write32(descOff.dwMaxTextureAspectRatio, caps.dwMaxTextureAspectRatio);
    write32(descOff.dwMaxAnisotropy, caps.dwMaxAnisotropy);

    // DX6+ fields
    write32(descOff.dwStencilCaps, caps.dwStencilCaps);
    write32(descOff.dwFVFCaps, 0x80008); // D3DFVFCAPS_DONOTSTRIPELEMENTS | max streams
    write32(descOff.dwTextureOpCaps, D3D_TEXTURE_OP_CAPS);
    write16(descOff.wMaxTextureBlendStages, caps.wMaxTextureBlendStages);
    write16(descOff.wMaxSimultaneousTextures, caps.wMaxSimultaneousTextures);
};

/**
 * Fill D3DDEVICEDESC7 (DX7) capabilities.
 * Official layout size is 236 bytes (includes device GUID and reserved tail fields).
 */
export const fillDeviceDesc7 = (
    view: DataView,
    addr: number,
    deviceGuid: ReadonlyArray<number> = D3D7_HAL_DEVICE_GUID_BYTES
): void => {
    if (!addr || addr < 0x10000) return;
    if (addr + D3DDEVICEDESC7_SIZE > view.byteLength) return;

    const caps = EmulatorConfig.getInstance().d3dCaps;
    const primOff = D3DPRIMCAPS_OFFSETS;

    // Per-device-kind dwDevCaps (rgb/hal/tnlhal split, see D3d7DeviceKind above).
    // Legacy switch restores the old uniform behavior: config caps verbatim + vpcaps 0.
    const legacy = isCaps7Legacy();
    const kind = d3d7DeviceKindForGuidBytes(deviceGuid);
    const devCaps = legacy ? caps.dwDevCaps : d3d7DevCapsForKind(kind, caps.dwDevCaps);
    const vertexProcessingCaps = legacy ? 0 : D3D7_VERTEX_PROCESSING_CAPS;

    const fillPrimCaps7 = (base: number) => {
        view.setUint32(base + primOff.dwSize, 56, true);
        view.setUint32(base + primOff.dwMiscCaps, D3D_PRIMCAPS_MISC, true);
        view.setUint32(base + primOff.dwRasterCaps, caps.dwRasterCaps, true);
        view.setUint32(base + primOff.dwZCmpCaps, caps.dwZCmpCaps, true);
        view.setUint32(base + primOff.dwSrcBlendCaps, caps.dwBlendCaps, true);
        view.setUint32(base + primOff.dwDestBlendCaps, caps.dwBlendCaps, true);
        view.setUint32(base + primOff.dwAlphaCmpCaps, caps.dwAlphaCmpCaps, true);
        view.setUint32(base + primOff.dwShadeCaps, caps.dwShadeCaps, true);
        view.setUint32(base + primOff.dwTextureCaps, caps.dwTextureCaps, true);
        view.setUint32(base + primOff.dwTextureFilterCaps, caps.dwTextureFilterCaps, true);
        view.setUint32(base + primOff.dwTextureBlendCaps, caps.dwTextureBlendCaps, true);
        view.setUint32(base + primOff.dwTextureAddressCaps, caps.dwTextureAddressCaps, true);
        view.setUint32(base + primOff.dwStippleWidth, 32, true);
        view.setUint32(base + primOff.dwStippleHeight, 32, true);
    };

    // 0: dwDevCaps
    view.setUint32(addr + 0, devCaps, true);
    // 4: dpcLineCaps (56 bytes)
    fillPrimCaps7(addr + 4);
    // 60: dpcTriCaps (56 bytes)
    fillPrimCaps7(addr + 60);
    // 116: dwDeviceRenderBitDepth
    view.setUint32(addr + 116, zBufferMask, true);
    // 120: dwDeviceZBufferBitDepth
    view.setUint32(addr + 120, zBufferMask, true);
    // 124..148: texture limits
    view.setUint32(addr + 124, caps.dwMinTextureWidth, true);
    view.setUint32(addr + 128, caps.dwMinTextureHeight, true);
    view.setUint32(addr + 132, caps.dwMaxTextureWidth, true);
    view.setUint32(addr + 136, caps.dwMaxTextureHeight, true);
    view.setUint32(addr + 140, caps.dwMaxTextureRepeat, true);
    view.setUint32(addr + 144, caps.dwMaxTextureAspectRatio, true);
    view.setUint32(addr + 148, caps.dwMaxAnisotropy, true);
    // 152..171: guard band/extents (floats)
    view.setFloat32(addr + 152, -1e6, true); // dvGuardBandLeft
    view.setFloat32(addr + 156, -1e6, true); // dvGuardBandTop
    view.setFloat32(addr + 160, 1e6, true);  // dvGuardBandRight
    view.setFloat32(addr + 164, 1e6, true);  // dvGuardBandBottom
    view.setFloat32(addr + 168, 0.0, true);  // dvExtentsAdjust
    // 172..186: caps and texture stages
    view.setUint32(addr + 172, caps.dwStencilCaps, true);
    view.setUint32(addr + 176, 0x80008, true); // D3DFVFCAPS_DONOTSTRIPELEMENTS | max streams
    view.setUint32(addr + 180, D3D_TEXTURE_OP_CAPS, true);
    view.setUint16(addr + 184, caps.wMaxTextureBlendStages, true);
    view.setUint16(addr + 186, caps.wMaxSimultaneousTextures, true);
    // 188..195: light/vertex W
    view.setUint32(addr + 188, 8, true);       // dwMaxActiveLights
    view.setFloat32(addr + 192, 1e10, true);   // dvMaxVertexW

    // 196: deviceGUID (16 bytes)
    for (let i = 0; i < 16; i++) {
        view.setUint8(addr + 196 + i, deviceGuid[i] ?? 0);
    }

    // 212..235: clip/vertex processing + reserved
    view.setUint16(addr + 212, 6, true);       // wMaxUserClipPlanes
    view.setUint16(addr + 214, 4, true);       // wMaxVertexBlendMatrices
    view.setUint32(addr + 216, vertexProcessingCaps, true); // dwVertexProcessingCaps
    view.setUint32(addr + 220, 0, true);       // dwReserved1
    view.setUint32(addr + 224, 0, true);       // dwReserved2
    view.setUint32(addr + 228, 0, true);       // dwReserved3
    view.setUint32(addr + 232, 0, true);       // dwReserved4
};
