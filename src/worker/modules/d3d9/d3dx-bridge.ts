/**
 * Bridge helpers for D3DX9 HLE — surface copy, mip filtering, texture upload.
 */

import { Mem } from '../../core/memory/mem-accessor';
import { resolveSurfaceInfo, resolveTextureInfo, D3D_OK, D3DERR_INVALIDCALL } from './resource-registry';
import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';

const D3DX_FILTER_LINEAR = 3;

type Rect = { left: number; top: number; right: number; bottom: number };

function readRect(ptr: number, fullW: number, fullH: number): Rect {
    if (!ptr) return { left: 0, top: 0, right: fullW, bottom: fullH };
    return {
        left: Mem.readInt32(ptr) ?? 0,
        top: Mem.readInt32(ptr + 4) ?? 0,
        right: Mem.readInt32(ptr + 8) ?? fullW,
        bottom: Mem.readInt32(ptr + 12) ?? fullH,
    };
}

function rectWidth(r: Rect): number {
    return Math.max(0, r.right - r.left);
}

function rectHeight(r: Rect): number {
    return Math.max(0, r.bottom - r.top);
}

function colorKeyMatch(pixelBgra: number, colorKey: number): boolean {
    if (colorKey === 0) return false;
    const ckB = colorKey & 0xff;
    const ckG = (colorKey >>> 8) & 0xff;
    const ckR = (colorKey >>> 16) & 0xff;
    const ckA = (colorKey >>> 24) & 0xff;
    const pB = pixelBgra & 0xff;
    const pG = (pixelBgra >>> 8) & 0xff;
    const pR = (pixelBgra >>> 16) & 0xff;
    const pA = (pixelBgra >>> 24) & 0xff;
    if (ckA !== 0 && pA !== ckA) return false;
    return pR === ckR && pG === ckG && pB === ckB;
}

function readPixelBgra(mem: Uint8Array, ptr: number): number {
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 4);
    return view.getUint32(0, true);
}

function writePixelBgra(mem: Uint8Array, ptr: number, pixel: number): void {
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 4);
    view.setUint32(0, pixel >>> 0, true);
}

function sampleBilinear(
    mem: Uint8Array,
    basePtr: number,
    pitch: number,
    x: number,
    y: number,
    maxW: number,
    maxH: number,
): number {
    const fx = Math.max(0, Math.min(maxW - 1, x));
    const fy = Math.max(0, Math.min(maxH - 1, y));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(maxW - 1, x0 + 1);
    const y1 = Math.min(maxH - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const p00 = readPixelBgra(mem, basePtr + y0 * pitch + x0 * 4);
    const p10 = readPixelBgra(mem, basePtr + y0 * pitch + x1 * 4);
    const p01 = readPixelBgra(mem, basePtr + y1 * pitch + x0 * 4);
    const p11 = readPixelBgra(mem, basePtr + y1 * pitch + x1 * 4);

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const ch = (c0: number, c1: number, c2: number, c3: number, shift: number) => {
        const v0 = (c0 >>> shift) & 0xff;
        const v1 = (c1 >>> shift) & 0xff;
        const v2 = (c2 >>> shift) & 0xff;
        const v3 = (c3 >>> shift) & 0xff;
        const top = lerp(v0, v1, tx);
        const bot = lerp(v2, v3, tx);
        return Math.round(lerp(top, bot, ty));
    };

    const b = ch(p00, p10, p01, p11, 0);
    const g = ch(p00, p10, p01, p11, 8);
    const r = ch(p00, p10, p01, p11, 16);
    const a = ch(p00, p10, p01, p11, 24);
    return (a << 24) | (r << 16) | (g << 8) | b;
}

export function d3dxLoadSurfaceFromSurface(
    mem: Uint8Array,
    destSurface: number,
    destRectPtr: number,
    srcSurface: number,
    srcRectPtr: number,
    filter: number,
    colorKey: number,
): number {
    const dest = resolveSurfaceInfo(destSurface);
    const src = resolveSurfaceInfo(srcSurface);
    if (!dest || !src) return D3DERR_INVALIDCALL;

    const destRect = readRect(destRectPtr, dest.width, dest.height);
    const srcRect = readRect(srcRectPtr, src.width, src.height);
    const dw = rectWidth(destRect);
    const dh = rectHeight(destRect);
    const sw = rectWidth(srcRect);
    const sh = rectHeight(srcRect);
    if (dw === 0 || dh === 0 || sw === 0 || sh === 0) return D3D_OK;

    const destLock = dest.device.lockTexture(dest.texturePtr, dest.level);
    const srcLock = src.device.lockTexture(src.texturePtr, src.level);
    if (!destLock || !srcLock) {
        if (destLock) dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
        if (srcLock) src.device.unlockTexture(src.texturePtr, src.level, mem);
        return D3DERR_INVALIDCALL;
    }

    const useLinear = filter === D3DX_FILTER_LINEAR;
    const srcBase = srcLock.ptr + srcRect.top * srcLock.pitch + srcRect.left * 4;
    const destBase = destLock.ptr + destRect.top * destLock.pitch + destRect.left * 4;

    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const srcX = sw === dw ? x : (x * (sw - 1)) / Math.max(1, dw - 1);
            const srcY = sh === dh ? y : (y * (sh - 1)) / Math.max(1, dh - 1);
            let pixel: number;
            if (useLinear && (sw > 1 || sh > 1)) {
                pixel = sampleBilinear(mem, srcBase, srcLock.pitch, srcX, srcY, sw, sh);
            } else {
                const sx = Math.min(sw - 1, Math.round(srcX));
                const sy = Math.min(sh - 1, Math.round(srcY));
                pixel = readPixelBgra(mem, srcBase + sy * srcLock.pitch + sx * 4);
            }
            if (colorKeyMatch(pixel, colorKey)) continue;
            writePixelBgra(mem, destBase + y * destLock.pitch + x * 4, pixel);
        }
    }

    dest.device.unlockTexture(dest.texturePtr, dest.level, mem);
    src.device.unlockTexture(src.texturePtr, src.level, mem);
    return D3D_OK;
}

function downsampleBox2x(
    src: Uint8Array,
    srcPitch: number,
    srcW: number,
    srcH: number,
    dst: Uint8Array,
    dstPitch: number,
    dstW: number,
    dstH: number,
): void {
    for (let y = 0; y < dstH; y++) {
        for (let x = 0; x < dstW; x++) {
            const sx = x * 2;
            const sy = y * 2;
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let count = 0;
            for (let oy = 0; oy < 2; oy++) {
                const py = Math.min(srcH - 1, sy + oy);
                for (let ox = 0; ox < 2; ox++) {
                    const px = Math.min(srcW - 1, sx + ox);
                    const off = py * srcPitch + px * 4;
                    b += src[off];
                    g += src[off + 1];
                    r += src[off + 2];
                    a += src[off + 3];
                    count++;
                }
            }
            const dstOff = y * dstPitch + x * 4;
            dst[dstOff] = Math.round(b / count);
            dst[dstOff + 1] = Math.round(g / count);
            dst[dstOff + 2] = Math.round(r / count);
            dst[dstOff + 3] = Math.round(a / count);
        }
    }
}

export function d3dxFilterTexture(texturePtr: number, srcLevel: number, _filter: number): number {
    const info = resolveTextureInfo(texturePtr);
    if (!info) return D3DERR_INVALIDCALL;

    const { device, meta } = info;
    const start = Math.max(0, srcLevel >>> 0);
    if (start >= meta.levels) return D3DERR_INVALIDCALL;

    let level = start;
    let srcPixels = device.getTextureLevelPixels(texturePtr, level);
    if (!srcPixels) return D3DERR_INVALIDCALL;

    while (level + 1 < meta.levels) {
        const dstW = Math.max(1, srcPixels.width >>> 1);
        const dstH = Math.max(1, srcPixels.height >>> 1);
        const dstPitch = dstW * 4;
        const dst = new Uint8Array(dstPitch * dstH);
        downsampleBox2x(
            srcPixels.data,
            srcPixels.pitch,
            srcPixels.width,
            srcPixels.height,
            dst,
            dstPitch,
            dstW,
            dstH,
        );
        if (!device.setTextureLevelPixels(texturePtr, level + 1, dst, dstPitch)) {
            return D3DERR_INVALIDCALL;
        }
        level++;
        srcPixels = { data: dst, pitch: dstPitch, width: dstW, height: dstH };
    }

    return D3D_OK;
}

/** Convert RGBA decode output to D3D A8R8G8B8 (BGRA byte order). */
export function rgbaToBgra(rgba: Uint8Array, out?: Uint8Array): Uint8Array {
    const dst = out ?? new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
        dst[i] = rgba[i + 2];
        dst[i + 1] = rgba[i + 1];
        dst[i + 2] = rgba[i];
        dst[i + 3] = rgba[i + 3];
    }
    return dst;
}

/**
 * Copy a DDS's surface bytes into a texture created in the SAME format, level by level.
 *
 * D3DX preserves the file's format by default (D3DFMT_FROM_FILE), and an engine that reads
 * GetLevelDesc back expects exactly what it asked for — decoding a block-compressed file to
 * RGBA answers a different question than the one it asked, besides costing 4x the memory and
 * every mip the file already contains. A DDS stores its mip chain consecutively, so the walk
 * is just the per-level layout.
 */
export function uploadDdsLevels(
    texturePtr: number,
    data: Uint8Array,
    dataOffset: number,
    format: number,
    width: number,
    height: number,
    levels: number,
): boolean {
    const info = resolveTextureInfo(texturePtr);
    if (!info) return false;
    let offset = dataOffset;
    for (let level = 0; level < levels; level++) {
        const w = Math.max(1, width >>> level);
        const h = Math.max(1, height >>> level);
        const layout = getD3DTextureLayout(format, w, h);
        if (offset + layout.bytes > data.length) {
            // A truncated chain is the file's business, not ours to invent: stop at what it
            // actually carries rather than uploading whatever follows it.
            return level > 0;
        }
        if (!info.device.setTextureLevelPixels(texturePtr, level, data.subarray(offset, offset + layout.bytes), layout.pitch)) {
            return false;
        }
        offset += layout.bytes;
    }
    return true;
}

/**
 * Copy a cube .dds straight into the six faces, in the FILE's own format — the block-compressed
 * sibling of uploadDdsLevels. A cube .dds stores the faces in +X,-X,+Y,-Y,+Z,-Z order, each
 * carrying its WHOLE mip chain, so the walk advances over every level the file holds even when
 * the caller asked for fewer: skipping that stride reads the next face from the middle of this
 * one, which decodes as plausible-looking garbage rather than as a failure. The walk itself is
 * separated out so that stride can be asserted without a live device behind it.
 */
export function ddsCubeFaceLayout(
    format: number,
    edge: number,
    fileLevels: number,
    dataOffset: number,
): Array<{ face: number; level: number; offset: number; bytes: number; pitch: number }> {
    const out: Array<{ face: number; level: number; offset: number; bytes: number; pitch: number }> = [];
    let offset = dataOffset;
    for (let face = 0; face < 6; face++) {
        for (let level = 0; level < fileLevels; level++) {
            const size = Math.max(1, edge >>> level);
            const layout = getD3DTextureLayout(format, size, size);
            out.push({ face, level, offset, bytes: layout.bytes, pitch: layout.pitch });
            offset += layout.bytes;
        }
    }
    return out;
}

export function uploadDdsCubeFaces(
    cubePtr: number,
    data: Uint8Array,
    dataOffset: number,
    format: number,
    edge: number,
    levels: number,
    fileLevels: number,
): boolean {
    const info = resolveTextureInfo(cubePtr);
    if (!info) return false;
    const setFace = (info.device as unknown as {
        setCubeFacePixels?: (t: number, f: number, l: number, src: Uint8Array, pitch: number) => boolean;
    }).setCubeFacePixels;
    if (!setFace) return false;
    let uploadedAny = false;
    for (const slice of ddsCubeFaceLayout(format, edge, fileLevels, dataOffset)) {
        if (slice.offset + slice.bytes > data.length) return uploadedAny;
        if (slice.level >= levels) continue;
        if (!setFace.call(info.device, cubePtr, slice.face, slice.level,
            data.subarray(slice.offset, slice.offset + slice.bytes), slice.pitch)) return false;
        uploadedAny = true;
    }
    return uploadedAny;
}

export function uploadRgbaToTexture(
    texturePtr: number,
    width: number,
    height: number,
    rgba: Uint8Array,
): boolean {
    const info = resolveTextureInfo(texturePtr);
    if (!info) return false;
    const bgra = rgbaToBgra(rgba);
    const pitch = width * 4;
    return info.device.setTextureLevelPixels(texturePtr, 0, bgra, pitch);
}
