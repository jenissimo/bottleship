import {
    DDPF_ALPHAPIXELS,
    DDPF_FOURCC,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDSD_CAPS,
    DDSD_HEIGHT,
    DDSD_LPSURFACE,
    DDSD_CKSRCBLT,
    DDSD_CKDESTBLT,
    DDSD_PITCH,
    DDSD_PIXELFORMAT,
    DDSD_REFRESHRATE,
    DDSD_WIDTH,
    DDSURFACEDESC_SIZE,
    DDSURFACEDESC_OFFSETS,
    DDSURFACEDESC2_SIZE,
    DDSURFACEDESC2_OFFSETS,
    DDPIXELFORMAT_OFFSETS,
    PALETTEENTRY_OFFSETS,
} from "./constants";
import { SurfaceFormat } from "./com-objects";
import { isValidAddress } from "../../core/memory/address-guard";
import { Logger, LogCategory } from "../../core/logger";
import { getSurfaceFormatLayout } from "../../backends/webgpu/shared/texture-formats";

export interface PaletteEntry {
    peRed: number;    // BYTE (0-255)
    peGreen: number;  // BYTE (0-255)
    peBlue: number;   // BYTE (0-255)
    peFlags: number;  // BYTE (flags)
}

export type SurfaceDesc = {
    size: number;
    flags: number;
    width: number;
    height: number;
    pitch: number;
    backBufferCount: number;
    caps: number;              // DDSCAPS2.dwCaps (first 4 bytes)
    caps2?: number;            // DDSCAPS2.dwCaps2 (DX7+ extensions)
    caps3?: number;            // DDSCAPS2.dwCaps3 (DX7+ extensions)
    caps4?: number;            // DDSCAPS2.dwCaps4 / dwVolumeDepth (union)
    surfacePtr: number;
    pixelFormat: SurfaceFormat | null;
    srcColorKey?: { low: number; high: number };  // ddckCKSrcBlt from DDSURFACEDESC2
    destColorKey?: { low: number; high: number }; // ddckCKDestBlt from DDSURFACEDESC2
    mipMapCount?: number;      // dwMipMapCount (for textures with mipmaps)
    textureStage?: number;     // dwTextureStage (for multi-texture rendering)
    alphaBitDepth?: number;    // dwAlphaBitDepth (usually redundant with pixel format)
};

export const createDefaultPixelFormat = (bpp: number): SurfaceFormat => {
    if (bpp === 8) {
        return {
            flags: DDPF_PALETTEINDEXED8,
            bpp: 8,
            rMask: 0,
            gMask: 0,
            bMask: 0,
            aMask: 0,
        };
    }

    if (bpp === 16) {
        return {
            flags: DDPF_RGB,
            bpp,
            rMask: 0xf800,
            gMask: 0x07e0,
            bMask: 0x001f,
            aMask: 0,
        };
    }

    return {
        flags: DDPF_RGB,
        bpp: bpp || 32,
        rMask: 0x00ff0000,
        gMask: 0x0000ff00,
        bMask: 0x000000ff,
        aMask: 0,
    };
};

export const computePitch = (width: number, bpp: number): number => {
    const bytesPerPixel = Math.max(1, Math.floor(bpp / 8));
    const rowBytes = Math.max(1, width) * bytesPerPixel;
    return (rowBytes + 31) & ~31;
};

export const readPixelFormat = (mem: Uint8Array, address: number): SurfaceFormat => {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(address + DDPIXELFORMAT_OFFSETS.size, true);
    if (size < 32) {
        return createDefaultPixelFormat(16);
    }

    const flags = view.getUint32(address + DDPIXELFORMAT_OFFSETS.flags, true);
    const fourCC = view.getUint32(address + DDPIXELFORMAT_OFFSETS.fourCC, true);
    const bpp = view.getUint32(address + DDPIXELFORMAT_OFFSETS.rgbBitCount, true);
    const rMask = view.getUint32(address + DDPIXELFORMAT_OFFSETS.rMask, true);
    const gMask = view.getUint32(address + DDPIXELFORMAT_OFFSETS.gMask, true);
    const bMask = view.getUint32(address + DDPIXELFORMAT_OFFSETS.bMask, true);
    const rawAMask = view.getUint32(address + DDPIXELFORMAT_OFFSETS.aMask, true);
    // Per DDraw spec, dwRGBAlphaBitMask is only valid when DDPF_ALPHAPIXELS is set.
    // Without this flag, the field is a union member for other purposes and may contain garbage.
    // Some games select XRGB1555 (no alpha) but the aMask field may read as 0x8000,
    // causing incorrect ARGB1555 detection and breaking colorkey-based transparency.
    const hasAlphaFlag = !!(flags & DDPF_ALPHAPIXELS);
    const aMask = hasAlphaFlag ? rawAMask : 0;

    // Diagnostic: log 16-bit formats to trace DDPF_ALPHAPIXELS presence
    if (bpp === 16 && rMask) {
        Logger.verbose(LogCategory.DDRAW,
            `readPixelFormat: bpp=16 flags=0x${flags.toString(16)} DDPF_ALPHAPIXELS=${hasAlphaFlag} ` +
            `rawAMask=0x${rawAMask.toString(16)} → aMask=0x${aMask.toString(16)} ` +
            `R=0x${rMask.toString(16)} G=0x${gMask.toString(16)} B=0x${bMask.toString(16)}`);
    }

    return {
        flags,
        fourCC: (flags & DDPF_FOURCC) !== 0 ? fourCC : undefined,
        bpp: bpp || 16,
        rMask: rMask || 0xf800,
        gMask: gMask || 0x07e0,
        bMask: bMask || 0x001f,
        aMask,
    };
};

export const writePixelFormat = (
    mem: Uint8Array,
    address: number,
    format: SurfaceFormat,
    targetSize: number = 32
): void => {
    if (!isValidAddress(mem, address, Math.min(Math.max(targetSize, 4), 32))) return;
    const cappedSize = Math.max(0, Math.min(targetSize, 32));
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const canWrite = (offset: number, bytes: number = 4) =>
        cappedSize >= offset + bytes && isValidAddress(mem, address + offset, bytes);
    if (canWrite(DDPIXELFORMAT_OFFSETS.size)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.size, cappedSize, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.flags)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.flags, format.flags, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.fourCC)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.fourCC, format.fourCC ?? 0, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.rgbBitCount)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.rgbBitCount, format.bpp, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.rMask)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.rMask, format.rMask, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.gMask)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.gMask, format.gMask, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.bMask)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.bMask, format.bMask, true);
    }
    if (canWrite(DDPIXELFORMAT_OFFSETS.aMask)) {
        view.setUint32(address + DDPIXELFORMAT_OFFSETS.aMask, format.aMask, true);
    }
};

export const readSurfaceDesc = (mem: Uint8Array, address: number): SurfaceDesc | null => {
    // Protect low memory (0x0-0xFFFF)
    if (!address || address < 0x10000 || address + 4 > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(address + DDSURFACEDESC2_OFFSETS.size, true);
    // DIAGNOSTIC: Log size for texture loading investigation
    Logger.verbose(LogCategory.DDRAW, `readSurfaceDesc: address=0x${address.toString(16)} size=${size} (lpSurface needs >= ${DDSURFACEDESC2_OFFSETS.lpSurface + 4})`);
    if (size < 4 || size > 0x2000 || address + size > mem.length) return null;

    const hasField = (offset: number, length: number = 4) => size >= offset + length;
    const flags = hasField(DDSURFACEDESC2_OFFSETS.flags) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.flags, true) : 0;
    const height = hasField(DDSURFACEDESC2_OFFSETS.height) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.height, true) : 0;
    const width = hasField(DDSURFACEDESC2_OFFSETS.width) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.width, true) : 0;
    const pitch = hasField(DDSURFACEDESC2_OFFSETS.pitch) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.pitch, true) : 0;
    const backBufferCount = hasField(DDSURFACEDESC2_OFFSETS.backBufferCount) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.backBufferCount, true) : 0;
    // Only read lpSurface if DDSD_LPSURFACE flag is set AND field exists
    // Otherwise garbage value may point to thunk/callback/spin regions and corrupt system memory
    const surfacePtr = (flags & DDSD_LPSURFACE) && hasField(DDSURFACEDESC2_OFFSETS.lpSurface)
        ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.lpSurface, true)
        : 0;
    // Read DDSCAPS2 (16 bytes total: dwCaps, dwCaps2, dwCaps3, dwCaps4)
    const caps = hasField(DDSURFACEDESC2_OFFSETS.caps) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.caps, true) : 0;
    const caps2 = hasField(DDSURFACEDESC2_OFFSETS.dwCaps2) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps2, true) : undefined;
    const caps3 = hasField(DDSURFACEDESC2_OFFSETS.dwCaps3) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps3, true) : undefined;
    const caps4 = hasField(DDSURFACEDESC2_OFFSETS.dwCaps4) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps4, true) : undefined;

    // Read additional fields
    const mipMapCount = hasField(DDSURFACEDESC2_OFFSETS.dwMipMapCount) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwMipMapCount, true) : undefined;
    const textureStage = hasField(DDSURFACEDESC2_OFFSETS.dwTextureStage) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwTextureStage, true) : undefined;
    const alphaBitDepth = hasField(DDSURFACEDESC2_OFFSETS.dwAlphaBitDepth) ? view.getUint32(address + DDSURFACEDESC2_OFFSETS.dwAlphaBitDepth, true) : undefined;

    const pixelFormatAddr = address + DDSURFACEDESC2_OFFSETS.pixelFormat;
    const pixelFormat =
        flags & DDSD_PIXELFORMAT && hasField(DDSURFACEDESC2_OFFSETS.pixelFormat, 32)
            ? readPixelFormat(mem, pixelFormatAddr)
            : null;

    // Read colorkey fields if structure is large enough (DDCOLORKEY = 8 bytes each)
    let srcColorKey: { low: number; high: number } | undefined;
    let destColorKey: { low: number; high: number } | undefined;
    // DDSD_CK*BLT is what makes the field valid — and it is the ONLY way to state a
    // BLACK key, which is the era's default for sprite sheets. Falling back to
    // "nonzero means present" alone silently drops key=0x0, so a DX2/3 title that
    // creates its UI textures with a black source key renders every keyed texel as
    // an opaque black box. The nonzero fallback stays for descs that fill the field
    // without setting the flag.
    if (hasField(DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt, 8)) {
        const srcLow = view.getUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt, true);
        const srcHigh = view.getUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt + 4, true);
        if ((flags & DDSD_CKSRCBLT) !== 0 || srcLow !== 0 || srcHigh !== 0) {
            srcColorKey = { low: srcLow, high: srcHigh };
            Logger.verbose(LogCategory.DDRAW,
                `readSurfaceDesc: Found srcColorKey 0x${srcLow.toString(16)}-0x${srcHigh.toString(16)}`
            );
        }
    }
    if (hasField(DDSURFACEDESC2_OFFSETS.ddckCKDestBlt, 8)) {
        const destLow = view.getUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKDestBlt, true);
        const destHigh = view.getUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKDestBlt + 4, true);
        if ((flags & DDSD_CKDESTBLT) !== 0 || destLow !== 0 || destHigh !== 0) {
            destColorKey = { low: destLow, high: destHigh };
            Logger.verbose(LogCategory.DDRAW,
                `readSurfaceDesc: Found destColorKey 0x${destLow.toString(16)}-0x${destHigh.toString(16)}`
            );
        }
    }

    return {
        size,
        flags,
        width,
        height,
        pitch,
        backBufferCount,
        caps,
        caps2: caps2 !== undefined && caps2 !== 0 ? caps2 : undefined,
        caps3: caps3 !== undefined && caps3 !== 0 ? caps3 : undefined,
        caps4: caps4 !== undefined && caps4 !== 0 ? caps4 : undefined,
        surfacePtr,
        pixelFormat,
        srcColorKey,
        destColorKey,
        mipMapCount: mipMapCount !== undefined && mipMapCount !== 0 ? mipMapCount : undefined,
        textureStage: textureStage !== undefined ? textureStage : undefined,
        alphaBitDepth: alphaBitDepth !== undefined && alphaBitDepth !== 0 ? alphaBitDepth : undefined,
    };
};

export const writeSurfaceDesc = (
    mem: Uint8Array,
    address: number,
    desc: SurfaceDesc
): void => {
    if (!isValidAddress(mem, address, 4)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(address + DDSURFACEDESC2_OFFSETS.size, true);
    const isStackAddr = address >= 0x80000 && address < 0x100000;

    // If dwSize is 0/garbage, use the size from desc (caller should set it)
    // or minimum safe size. Do NOT default to 124 bytes - this can overflow stack buffers!
    let targetSize: number;
    if (size >= DDSURFACEDESC_SIZE && size <= DDSURFACEDESC2_SIZE) {
        // Valid size range (108-124)
        targetSize = size;
    } else if (desc.size && desc.size >= DDSURFACEDESC_SIZE && desc.size <= DDSURFACEDESC2_SIZE) {
        // Use caller-provided size from desc
        targetSize = desc.size;
        Logger.warn(LogCategory.DDRAW,
            `writeSurfaceDesc: dwSize at 0x${address.toString(16)} was ${size}, using desc.size=${desc.size}`);
    } else {
        // Conservative default - use v1 size to avoid overflow
        targetSize = DDSURFACEDESC_SIZE;  // 108 bytes, not 124!
        Logger.warn(LogCategory.DDRAW,
            `writeSurfaceDesc: dwSize at 0x${address.toString(16)} was ${size} (invalid), defaulting to ${targetSize} bytes`);
    }

    if (!isValidAddress(mem, address, targetSize)) return;

    // Avoid bulk zeroing on stack addresses to reduce blast radius if caller passed a bad pointer.
    if (!isStackAddr) {
        mem.fill(0, address, address + targetSize);
    }

    const canWrite = (offset: number, length: number = 4) => targetSize >= offset + length;
    if (canWrite(DDSURFACEDESC2_OFFSETS.size)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.size, targetSize, true);
    }
    // Build flags based on what we actually write (not what game sent)
    // Old engines check flags strictly - if DDSD_LPSURFACE is set but DDSD_PITCH is missing, they won't write
    let flags = desc.flags ?? 0;
    
    // We always write these fields — flags must be set
    if (desc.width) flags |= DDSD_WIDTH;
    if (desc.height) flags |= DDSD_HEIGHT;
    if (desc.pitch) flags |= DDSD_PITCH;
    
    // We always write pixelFormat — flag is mandatory
    flags |= DDSD_PIXELFORMAT;
    
    // We write caps if provided
    if (desc.caps) flags |= DDSD_CAPS;
    
    // If lpSurface is provided, MUST also have PITCH and other flags
    if (desc.surfacePtr && desc.surfacePtr > 0) {
        flags |= DDSD_LPSURFACE;
        flags |= DDSD_PITCH; // Absolutely required if lpSurface is set
        flags |= DDSD_PIXELFORMAT; // Also required
        if (desc.caps) flags |= DDSD_CAPS;
        Logger.verbose(LogCategory.DDRAW, `writeSurfaceDesc: adding DDSD_LPSURFACE, flags=0x${flags.toString(16)}, surfacePtr=0x${desc.surfacePtr.toString(16)}, lpSurface_offset=${DDSURFACEDESC2_OFFSETS.lpSurface}`);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.flags)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.flags, flags, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.height)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.height, desc.height, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.width)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.width, desc.width, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.pitch)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.pitch, desc.pitch, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.backBufferCount)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.backBufferCount, desc.backBufferCount, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.lpSurface)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.lpSurface, desc.surfacePtr, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.pixelFormat, 32) && desc.pixelFormat) {
        writePixelFormat(mem, address + DDSURFACEDESC2_OFFSETS.pixelFormat, desc.pixelFormat);
    }
    // Write DDSCAPS2 (full 16 bytes if available)
    if (canWrite(DDSURFACEDESC2_OFFSETS.caps)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.caps, desc.caps, true);
    }
    if (desc.caps2 !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwCaps2)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps2, desc.caps2, true);
    }
    if (desc.caps3 !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwCaps3)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps3, desc.caps3, true);
    }
    if (desc.caps4 !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwCaps4)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwCaps4, desc.caps4, true);
    }
    // Write additional fields
    if (desc.mipMapCount !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwMipMapCount)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwMipMapCount, desc.mipMapCount, true);
    }
    if (desc.textureStage !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwTextureStage)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwTextureStage, desc.textureStage, true);
    }
    if (desc.alphaBitDepth !== undefined && canWrite(DDSURFACEDESC2_OFFSETS.dwAlphaBitDepth)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwAlphaBitDepth, desc.alphaBitDepth, true);
    }
    // Write colorkeys if present
    if (desc.srcColorKey && canWrite(DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt, 8)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt, desc.srcColorKey.low, true);
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKSrcBlt + 4, desc.srcColorKey.high, true);
    }
    if (desc.destColorKey && canWrite(DDSURFACEDESC2_OFFSETS.ddckCKDestBlt, 8)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKDestBlt, desc.destColorKey.low, true);
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.ddckCKDestBlt + 4, desc.destColorKey.high, true);
    }
};

// Functions for DDSURFACEDESC (v1) - 108 bytes, DDSCAPS (4 bytes)
export const readSurfaceDescV1 = (mem: Uint8Array, address: number): SurfaceDesc | null => {
    // Protect low memory (0x0-0xFFFF)
    if (!address || address < 0x10000 || address + 4 > mem.length) return null;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(address + DDSURFACEDESC_OFFSETS.size, true);
    Logger.verbose(LogCategory.DDRAW, `readSurfaceDescV1: address=0x${address.toString(16)} size=${size} (lpSurface needs >= ${DDSURFACEDESC_OFFSETS.lpSurface + 4})`);
    if (size < 4 || size > 0x2000 || address + size > mem.length) return null;

    const hasField = (offset: number, length: number = 4) => size >= offset + length;
    const flags = hasField(DDSURFACEDESC_OFFSETS.flags) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.flags, true) : 0;
    const height = hasField(DDSURFACEDESC_OFFSETS.height) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.height, true) : 0;
    const width = hasField(DDSURFACEDESC_OFFSETS.width) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.width, true) : 0;
    const pitch = hasField(DDSURFACEDESC_OFFSETS.pitch) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.pitch, true) : 0;
    const backBufferCount = hasField(DDSURFACEDESC_OFFSETS.backBufferCount) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.backBufferCount, true) : 0;
    // Only read lpSurface if DDSD_LPSURFACE flag is set AND field exists
    const surfacePtr = (flags & DDSD_LPSURFACE) && hasField(DDSURFACEDESC_OFFSETS.lpSurface)
        ? view.getUint32(address + DDSURFACEDESC_OFFSETS.lpSurface, true)
        : 0;
    // DDSCAPS is 4 bytes in v1 (vs 16 bytes DDSCAPS2 in v2), so we only read first 4 bytes
    const caps = hasField(DDSURFACEDESC_OFFSETS.caps) ? view.getUint32(address + DDSURFACEDESC_OFFSETS.caps, true) : 0;
    const pixelFormatAddr = address + DDSURFACEDESC_OFFSETS.pixelFormat;
    const pixelFormat =
        flags & DDSD_PIXELFORMAT && hasField(DDSURFACEDESC_OFFSETS.pixelFormat, 32)
            ? readPixelFormat(mem, pixelFormatAddr)
            : null;

    return {
        size,
        flags,
        width,
        height,
        pitch,
        backBufferCount,
        caps,
        surfacePtr,
        pixelFormat,
    };
};

export const writeSurfaceDescV1 = (
    mem: Uint8Array,
    address: number,
    desc: SurfaceDesc
): void => {
    if (!isValidAddress(mem, address, 4)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const size = view.getUint32(address + DDSURFACEDESC_OFFSETS.size, true);
    // For v1, we cap at 108 bytes (DDSURFACEDESC_SIZE) instead of 124
    const targetSize = size >= 4 ? Math.min(size, DDSURFACEDESC_SIZE) : DDSURFACEDESC_SIZE;
    if (!isValidAddress(mem, address, targetSize)) return;
    const isStackAddr = address >= 0x80000 && address < 0x100000;

    // Avoid bulk zeroing on stack addresses to reduce blast radius if caller passed a bad pointer.
    if (!isStackAddr) {
        mem.fill(0, address, address + targetSize);
    }

    const canWrite = (offset: number, length: number = 4) => targetSize >= offset + length;
    if (canWrite(DDSURFACEDESC_OFFSETS.size)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.size, targetSize, true);
    }
    
    // Build flags based on what we actually write (same logic as v2)
    let flags = desc.flags ?? 0;
    if (desc.width) flags |= DDSD_WIDTH;
    if (desc.height) flags |= DDSD_HEIGHT;
    if (desc.pitch) flags |= DDSD_PITCH;
    flags |= DDSD_PIXELFORMAT;
    if (desc.caps) flags |= DDSD_CAPS;
    
    if (desc.surfacePtr && desc.surfacePtr > 0) {
        flags |= DDSD_LPSURFACE;
        flags |= DDSD_PITCH;
        flags |= DDSD_PIXELFORMAT;
        if (desc.caps) flags |= DDSD_CAPS;
    }
    
    if (canWrite(DDSURFACEDESC_OFFSETS.flags)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.flags, flags, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.height)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.height, desc.height, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.width)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.width, desc.width, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.pitch)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.pitch, desc.pitch, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.backBufferCount)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.backBufferCount, desc.backBufferCount, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.lpSurface)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.lpSurface, desc.surfacePtr, true);
    }
    if (canWrite(DDSURFACEDESC_OFFSETS.pixelFormat, 32) && desc.pixelFormat) {
        writePixelFormat(mem, address + DDSURFACEDESC_OFFSETS.pixelFormat, desc.pixelFormat);
    }
    // DDSCAPS is 4 bytes in v1 (vs 16 bytes DDSCAPS2 in v2), so we only write first 4 bytes
    if (canWrite(DDSURFACEDESC_OFFSETS.caps)) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.caps, desc.caps, true);
    }
};

export const writeDisplayModeDesc = (
    mem: Uint8Array,
    address: number,
    size: number,
    width: number,
    height: number,
    bpp: number,
    refreshRate: number = 0,
): void => {
    if (!isValidAddress(mem, address, 4)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const cappedSize = Math.min(Math.max(size, 4), DDSURFACEDESC2_SIZE);

    if (!isValidAddress(mem, address, cappedSize)) return;

    mem.fill(0, address, address + cappedSize);
    const canWrite = (offset: number, length: number = 4) => cappedSize >= offset + length;
    if (canWrite(DDSURFACEDESC2_OFFSETS.size)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.size, cappedSize, true);
    }
    let flags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT;
    if (refreshRate > 0) flags |= DDSD_REFRESHRATE;
    if (canWrite(DDSURFACEDESC2_OFFSETS.flags)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.flags, flags, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.height)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.height, height, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.width)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.width, width, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.pitch)) {
        const pitch = computePitch(width, bpp);
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.pitch, pitch >>> 0, true);
    }
    if (refreshRate > 0 && canWrite(DDSURFACEDESC2_OFFSETS.dwMipMapCount)) {
        view.setUint32(address + DDSURFACEDESC2_OFFSETS.dwMipMapCount, refreshRate, true);
    }
    if (canWrite(DDSURFACEDESC2_OFFSETS.pixelFormat, 32)) {
        writePixelFormat(mem, address + DDSURFACEDESC2_OFFSETS.pixelFormat, createDefaultPixelFormat(bpp));
    }
};

/**
 * Write display mode into a DDSURFACEDESC (v1, 108 bytes) struct.
 * Used by IDirectDraw/IDirectDraw2 EnumDisplayModes callbacks.
 */
export const writeDisplayModeDescV1 = (
    mem: Uint8Array,
    address: number,
    width: number,
    height: number,
    bpp: number,
    refreshRate: number = 0,
): void => {
    if (!isValidAddress(mem, address, DDSURFACEDESC_SIZE)) return;
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

    mem.fill(0, address, address + DDSURFACEDESC_SIZE);
    view.setUint32(address + DDSURFACEDESC_OFFSETS.size, DDSURFACEDESC_SIZE, true);
    let flags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT;
    if (refreshRate > 0) flags |= DDSD_REFRESHRATE;
    view.setUint32(address + DDSURFACEDESC_OFFSETS.flags, flags, true);
    view.setUint32(address + DDSURFACEDESC_OFFSETS.height, height, true);
    view.setUint32(address + DDSURFACEDESC_OFFSETS.width, width, true);
    view.setUint32(address + DDSURFACEDESC_OFFSETS.pitch, (computePitch(width, bpp)) >>> 0, true);
    if (refreshRate > 0) {
        view.setUint32(address + DDSURFACEDESC_OFFSETS.dwRefreshRate, refreshRate, true);
    }
    writePixelFormat(mem, address + DDSURFACEDESC_OFFSETS.pixelFormat, createDefaultPixelFormat(bpp));
};

export const normalizeSurfaceDesc = (
    input: SurfaceDesc,
    fallbackWidth: number,
    fallbackHeight: number,
    fallbackBpp: number
): SurfaceDesc => {
    // A PRIMARY surface's dimensions ALWAYS come from the current display mode — Windows
    // ignores any width/height/pitch in the descriptor. Apps create it with only
    // DDSD_CAPS(+DDSD_BACKBUFFERCOUNT) set, leaving the width/height/pitch FIELDS
    // uninitialized; honoring those garbage values yields an absurd pitch*height surface
    // size → DDERR_OUTOFVIDEOMEMORY (HL's sw.dll engine: 320x240 primary computed a 5.2 TB
    // alloc → engine derail). Force the display-mode dims for primary surfaces.
    const DDSCAPS_PRIMARYSURFACE = 0x00000200;
    const isPrimary = (input.caps & DDSCAPS_PRIMARYSURFACE) !== 0;
    const pixelFormat = input.pixelFormat?.bpp || input.pixelFormat?.fourCC
        ? input.pixelFormat
        : createDefaultPixelFormat(fallbackBpp);
    const width = isPrimary ? fallbackWidth : (input.width || fallbackWidth);
    const height = isPrimary ? fallbackHeight : (input.height || fallbackHeight);
    const layout = getSurfaceFormatLayout(pixelFormat, width, height);
    const computedPitch = layout.compressed ? layout.pitch : computePitch(width, pixelFormat.bpp);
    const pitch = isPrimary
        ? computePitch(fallbackWidth, pixelFormat.bpp)
        : (input.pitch || computedPitch);
    let flags =
        input.flags ||
        (DDSD_WIDTH | DDSD_HEIGHT | DDSD_PITCH | DDSD_PIXELFORMAT);

    // Auto mipmap count: a MIPMAP|COMPLEX texture created WITHOUT DDSD_MIPMAPCOUNT gets a full chain
    // down to 1×1 (real DDraw7 "undocumented" behavior — wine surface.c:6965). Without this the mip
    // loop in CreateSurface (requestedMipLevels > 1) builds NO sublevels, so GetAttachedSurface finds
    // none and the game's per-level fill loop terminates immediately → flat single-level textures.
    // (v1–v4 interfaces use min(w,h)+1; DX7's max(w,h)+1 is used here as the dominant case.)
    const DDSCAPS_MIPMAP = 0x00400000;
    const DDSCAPS_COMPLEX = 0x00000008;
    const DDSD_MIPMAPCOUNT = 0x00020000;
    let mipMapCount = input.mipMapCount;
    if ((input.caps & DDSCAPS_MIPMAP) && (input.caps & DDSCAPS_COMPLEX) && !mipMapCount) {
        mipMapCount = Math.floor(Math.log2(Math.max(1, Math.max(width, height)))) + 1;
        flags |= DDSD_MIPMAPCOUNT;
    }

    return {
        ...input,
        width,
        height,
        pitch,
        flags,
        pixelFormat,
        mipMapCount,
    };
};

/**
 * Read a PALETTEENTRY structure from memory.
 */
export const readPaletteEntry = (mem: Uint8Array, address: number): PaletteEntry => {
    return {
        peRed: mem[address + PALETTEENTRY_OFFSETS.peRed],
        peGreen: mem[address + PALETTEENTRY_OFFSETS.peGreen],
        peBlue: mem[address + PALETTEENTRY_OFFSETS.peBlue],
        peFlags: mem[address + PALETTEENTRY_OFFSETS.peFlags],
    };
};

/**
 * Write a PALETTEENTRY structure to memory.
 */
export const writePaletteEntry = (mem: Uint8Array, address: number, entry: PaletteEntry): void => {
    mem[address + PALETTEENTRY_OFFSETS.peRed] = entry.peRed;
    mem[address + PALETTEENTRY_OFFSETS.peGreen] = entry.peGreen;
    mem[address + PALETTEENTRY_OFFSETS.peBlue] = entry.peBlue;
    mem[address + PALETTEENTRY_OFFSETS.peFlags] = entry.peFlags;
};
