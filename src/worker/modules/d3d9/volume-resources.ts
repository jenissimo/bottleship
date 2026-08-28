/**
 * CPU-side storage for D3D9 volume textures.
 *
 * A volume texture is a mip chain of tightly packed 3-D images.  WebGPU's
 * native 3-D path is wired by the device backend; this module deliberately
 * owns the API-visible storage and LockBox rules so the COM surface remains
 * correct even when a backend cannot expose a 3-D sampling view yet.
 */

import { getD3DTextureLayout } from '../../backends/webgpu/shared/texture-formats';

export interface VolumeAllocator {
    alloc(size: number, tag?: "HEAP"): number;
    free(ptr: number): void;
}

export interface VolumeBox {
    left: number;
    top: number;
    front: number;
    right: number;
    bottom: number;
    back: number;
}

export interface VolumeLevel {
    width: number;
    height: number;
    depth: number;
    pitch: number;
    slicePitch: number;
    bytes: number;
    ptr: number;
    locked: VolumeBox | null;
}

export interface VolumeTextureResource {
    width: number;
    height: number;
    depth: number;
    levels: number;
    usage: number;
    pool: number;
    format: number;
    levelData: VolumeLevel[];
    allocator: VolumeAllocator;
}

/** Stable texture metadata keyed by the guest COM pointer. */
export const volumeTextureResources = new Map<number, VolumeTextureResource>();

/** Stable IDirect3DVolume9 child pointer keyed by parent texture and mip level. */
export const volumeLevelObjects = new Map<number, Map<number, number>>();

/** Child volume pointer -> owning texture and mip level. */
export const volumeLevelParents = new Map<number, { texturePtr: number; level: number }>();

export function computeVolumeMipLevelCount(width: number, height: number, depth: number): number {
    const maxDim = Math.max(1, width >>> 0, height >>> 0, depth >>> 0);
    return Math.floor(Math.log2(maxDim)) + 1;
}

export function getVolumeLevelDims(
    width: number,
    height: number,
    depth: number,
    level: number,
): { width: number; height: number; depth: number } {
    const lv = level >>> 0;
    return {
        width: Math.max(1, width >>> lv),
        height: Math.max(1, height >>> lv),
        depth: Math.max(1, depth >>> lv),
    };
}

function checkedByteCount(value: number): number {
    // Guest allocations are 32-bit addresses.  Refuse arithmetic that could
    // wrap and turn a malformed CreateVolumeTexture into an undersized store.
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) {
        throw new RangeError(`volume allocation is too large: ${value}`);
    }
    return value;
}

export function createVolumeTextureResource(
    width: number,
    height: number,
    depth: number,
    levels: number,
    usage: number,
    pool: number,
    format: number,
    allocator: VolumeAllocator,
): VolumeTextureResource | null {
    const w = width >>> 0;
    const h = height >>> 0;
    const d = depth >>> 0;
    if (w === 0 || h === 0 || d === 0) return null;
    const fullLevelCount = computeVolumeMipLevelCount(w, h, d);
    const requestedLevels = levels >>> 0;
    if (requestedLevels > fullLevelCount) return null;
    const levelCount = requestedLevels === 0 ? fullLevelCount : requestedLevels;
    const resource: VolumeTextureResource = {
        width: w,
        height: h,
        depth: d,
        levels: levelCount,
        usage: usage >>> 0,
        pool: pool >>> 0,
        format: format >>> 0,
        levelData: [],
        allocator,
    };

    try {
        for (let level = 0; level < levelCount; level++) {
            const dims = getVolumeLevelDims(w, h, d, level);
            const layout = getD3DTextureLayout(format, dims.width, dims.height);
            const slicePitch = checkedByteCount(layout.pitch * layout.rows);
            const bytes = checkedByteCount(slicePitch * dims.depth);
            const ptr = allocator.alloc(bytes, 'HEAP');
            resource.levelData.push({
                width: dims.width,
                height: dims.height,
                depth: dims.depth,
                pitch: layout.pitch,
                slicePitch,
                bytes,
                ptr: ptr >>> 0,
                locked: null,
            });
        }
        return resource;
    } catch {
        for (const level of resource.levelData) allocator.free(level.ptr);
        return null;
    }
}

export function releaseVolumeTextureResource(texturePtr: number): void {
    const key = texturePtr >>> 0;
    const resource = volumeTextureResources.get(key);
    if (resource) {
        for (const level of resource.levelData) resource.allocator.free(level.ptr);
        volumeTextureResources.delete(key);
    }
    const children = volumeLevelObjects.get(key);
    if (children) {
        for (const child of children.values()) volumeLevelParents.delete(child);
    }
    volumeLevelObjects.delete(key);
}

export function getVolumeLevel(texturePtr: number, level: number): VolumeLevel | null {
    const resource = volumeTextureResources.get(texturePtr >>> 0);
    if (!resource || level < 0 || level >= resource.levels) return null;
    return resource.levelData[level] ?? null;
}

function validBox(box: VolumeBox, level: VolumeLevel): boolean {
    return Number.isInteger(box.left) && Number.isInteger(box.top) && Number.isInteger(box.front)
        && Number.isInteger(box.right) && Number.isInteger(box.bottom) && Number.isInteger(box.back)
        && box.left >= 0 && box.top >= 0 && box.front >= 0
        && box.right > box.left && box.bottom > box.top && box.back > box.front
        && box.right <= level.width && box.bottom <= level.height && box.back <= level.depth;
}

/**
 * Lock a mip level and return the address of the requested box origin.  The
 * row/slice pitch always describe the complete mip level, exactly as D3D9's
 * D3DLOCKED_BOX contract requires.
 */
export function lockVolumeBox(
    texturePtr: number,
    levelIndex: number,
    box: VolumeBox | null,
): { ptr: number; rowPitch: number; slicePitch: number } | null {
    const level = getVolumeLevel(texturePtr, levelIndex);
    if (!level || level.locked) return null;
    const lockBox = box ?? {
        left: 0, top: 0, front: 0,
        right: level.width, bottom: level.height, back: level.depth,
    };
    if (!validBox(lockBox, level)) return null;
    // Compressed formats address blocks, not individual texels.  The public
    // D3D box still uses texel coordinates; callers must name block-aligned
    // edges except at the mip boundary.
    const layout = getD3DTextureLayout(
        volumeTextureResources.get(texturePtr >>> 0)!.format,
        level.width,
        level.height,
    );
    if (layout.compressed) {
        const block = 4;
        const aligned = (v: number, extent: number): boolean => v === 0 || v === extent || (v % block) === 0;
        if (!aligned(lockBox.left, level.width) || !aligned(lockBox.top, level.height)
            || !aligned(lockBox.right, level.width) || !aligned(lockBox.bottom, level.height)) {
            return null;
        }
    }
    const x = layout.compressed ? Math.floor(lockBox.left / 4) : lockBox.left;
    const y = layout.compressed ? Math.floor(lockBox.top / 4) : lockBox.top;
    const texelBytes = layout.compressed
        ? layout.blockBytes
        : getD3DTextureLayout(
            volumeTextureResources.get(texturePtr >>> 0)!.format,
            1,
            1,
        ).pitch;
    const offset = lockBox.front * level.slicePitch + y * level.pitch + x * texelBytes;
    if (offset < 0 || offset >= level.bytes) return null;
    level.locked = { ...lockBox };
    return {
        ptr: (level.ptr + offset) >>> 0,
        rowPitch: level.pitch >>> 0,
        slicePitch: level.slicePitch >>> 0,
    };
}

export function unlockVolumeBox(texturePtr: number, levelIndex: number): boolean {
    const level = getVolumeLevel(texturePtr, levelIndex);
    if (!level || !level.locked) return false;
    level.locked = null;
    return true;
}

export function clearVolumeResources(): void {
    // The normal reset path drains COM finalizers first.  This function is a
    // defensive registry reset for tests and process teardown; it cannot free
    // guest memory without the allocator retained by each resource.
    for (const resource of volumeTextureResources.values()) {
        for (const level of resource.levelData) resource.allocator.free(level.ptr);
    }
    volumeTextureResources.clear();
    volumeLevelObjects.clear();
    volumeLevelParents.clear();
}
