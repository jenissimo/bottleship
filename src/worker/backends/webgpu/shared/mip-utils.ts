/**
 * Shared mip-chain math for the DirectX backends. Pure functions (no GPU/state) so they are
 * trivially unit-testable and identical across DDraw/D3D7, D3D8 and D3D9.
 */

/** Number of mip levels for a full chain down to 1×1 (matches Wine wined3d_log2i+1 / DXVK). */
export function mipLevelCountFor(width: number, height: number): number {
    return Math.floor(Math.log2(Math.max(1, Math.max(width, height)))) + 1;
}

/** Extent of a single dimension at a given mip level (NPOT-correct: floor-halving, min 1). */
export function mipExtent(dim: number, level: number): number {
    return Math.max(1, dim >>> level);
}

/**
 * How many mip levels to actually allocate/upload for a texture.
 *
 * Faithful-but-conservative: we only create slots we have AUTHORED data for, so a game that
 * declared N levels but filled only level 0 gets a single-level texture (no black/empty mips)
 * rather than a chain of transparent garbage. Auto-generation of missing levels is a separate
 * (AUTOGENMIPMAP / GenerateMipSubLevels) concern.
 *
 * @param declaredLevels  the game's requested level count (0 => full chain, i.e. CreateTexture Levels=0)
 * @param hasLevel        predicate: is authored pixel data present for mip `level` (>0)?
 */
export function effectiveMipLevels(
    declaredLevels: number,
    width: number,
    height: number,
    hasLevel: (level: number) => boolean,
): number {
    const maxLevels = mipLevelCountFor(width, height);
    const declared = declaredLevels > 0 ? Math.min(declaredLevels, maxLevels) : maxLevels;
    let n = 1;
    while (n < declared && hasLevel(n)) n++;
    return n;
}

/**
 * Describe the contiguous authored mip levels that a D3D texture upload can expose.
 * Keeping the extent/layout calculation in one pure helper makes compressed uploads
 * testable without constructing a GPUDevice; callers still decide whether to decode
 * or upload the bytes natively.
 */
export interface D3DTextureMipUploadLevel {
    level: number;
    width: number;
    height: number;
}

export function d3dTextureMipUploadPlan(
    width: number,
    height: number,
    declaredLevels: number,
    hasLevel: (level: number) => boolean,
): D3DTextureMipUploadLevel[] {
    const count = effectiveMipLevels(declaredLevels, width, height, hasLevel);
    const result: D3DTextureMipUploadLevel[] = [];
    for (let level = 0; level < count; level++) {
        result.push({
            level,
            width: mipExtent(width, level),
            height: mipExtent(height, level),
        });
    }
    return result;
}

/**
 * Cube textures expose a mip only when every one of their six faces has authored data for
 * that level.  A partial face set must not become a sampler-visible black/transparent mip.
 */
export function effectiveCubeMipLevels(
    declaredLevels: number,
    width: number,
    height: number,
    hasFaceLevel: (face: number, level: number) => boolean,
): number {
    return effectiveMipLevels(declaredLevels, width, height, (level) => {
        for (let face = 0; face < 6; face++) {
            if (!hasFaceLevel(face, level)) return false;
        }
        return true;
    });
}
