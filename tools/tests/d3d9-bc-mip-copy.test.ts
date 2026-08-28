import { describe, expect, test } from "bun:test";
import {
    blockCompressedCopyDim,
    getD3DTextureLayout,
    D3DFMT_A8R8G8B8,
    D3DFMT_DXT1,
    D3DFMT_DXT2,
    D3DFMT_DXT3,
    D3DFMT_DXT4,
    D3DFMT_DXT5,
} from "../../src/worker/backends/webgpu/shared/texture-formats";
import { blocksHigh } from "../../src/worker/backends/webgpu/shared/dxt";
import { mipExtent, mipLevelCountFor } from "../../src/worker/backends/webgpu/shared/mip-utils";

const BLOCK = 4;

interface CopyParams {
    level: number;
    bytesPerRow: number;
    rowsPerImage: number;
    copyWidth: number;
    copyHeight: number;
    dataBytes: number;
}

/**
 * The WebGPU validation rules a compressed queue.writeTexture must satisfy, transcribed from
 * the spec's "validating texture copy range" + "validating linear texture data": copySize is
 * bounded by the PHYSICAL (whole-block) miplevel extent and must itself be a whole number of
 * blocks. Unlike D3D/Vulkan, the extent may not stop at the logical image edge. Dawn reports a
 * violation as "copySize.width (N) is not a multiple of compressed texture format block width
 * (4)" — and a rejected copy invalidates the whole command buffer, so the visible symptom is
 * every draw in the frame silently disappearing, not an exception.
 */
function webgpuCopyErrors(p: CopyParams, physicalWidth: number, physicalHeight: number, blockBytes: number): string[] {
    const errors: string[] = [];
    if (p.copyWidth % BLOCK !== 0) {
        errors.push(`copySize.width (${p.copyWidth}) is not a multiple of compressed texture format block width (${BLOCK}).`);
    }
    if (p.copyHeight % BLOCK !== 0) {
        errors.push(`copySize.height (${p.copyHeight}) is not a multiple of compressed texture format block height (${BLOCK}).`);
    }
    if (p.copyWidth > physicalWidth || p.copyHeight > physicalHeight) {
        errors.push(`copySize (${p.copyWidth}x${p.copyHeight}) exceeds the physical mip extent (${physicalWidth}x${physicalHeight}).`);
    }
    const widthInBlocks = Math.ceil(p.copyWidth / BLOCK);
    const heightInBlocks = Math.ceil(p.copyHeight / BLOCK);
    if (p.bytesPerRow < widthInBlocks * blockBytes) {
        errors.push(`bytesPerRow (${p.bytesPerRow}) is smaller than one block row (${widthInBlocks * blockBytes}).`);
    }
    if (p.rowsPerImage < heightInBlocks) {
        errors.push(`rowsPerImage (${p.rowsPerImage}) is smaller than the copy's block rows (${heightInBlocks}).`);
    }
    const required = heightInBlocks === 0 ? 0 : p.bytesPerRow * (heightInBlocks - 1) + widthInBlocks * blockBytes;
    if (p.dataBytes < required) {
        errors.push(`data (${p.dataBytes} bytes) is smaller than the copy requires (${required}).`);
    }
    return errors;
}

/**
 * The copy parameters ensureDxtTexture emits per authored mip level (d3d9-device.ts, useBc
 * branch): bytesPerRow is the level's block-row pitch, the extent comes from
 * blockCompressedCopyDim, and the source is the level's whole authored surface.
 * rowsPerImage is omitted at the call site, which for a single-layer copy defaults to the
 * copy's own block rows — modelled here as blocksHigh(logical height), the same number.
 */
function emitChain(format: number, width: number, height: number): CopyParams[] {
    const out: CopyParams[] = [];
    for (let level = 0; level < mipLevelCountFor(width, height); level++) {
        const w = mipExtent(width, level);
        const h = mipExtent(height, level);
        const layout = getD3DTextureLayout(format, w, h);
        out.push({
            level,
            bytesPerRow: layout.pitch,
            rowsPerImage: blocksHigh(h),
            copyWidth: blockCompressedCopyDim(format, w),
            copyHeight: blockCompressedCopyDim(format, h),
            dataBytes: layout.bytes,
        });
    }
    return out;
}

/** Same chain, but with the LOGICAL mip extent as the copy size — what an unrounded path passes. */
function emitChainLogical(format: number, width: number, height: number): CopyParams[] {
    return emitChain(format, width, height).map((p) => ({
        ...p,
        copyWidth: mipExtent(width, p.level),
        copyHeight: mipExtent(height, p.level),
    }));
}

/** Physical (whole-block) extent that backs a logical one. */
function physical(dim: number): number {
    return (Math.max(1, dim) + BLOCK - 1) & ~(BLOCK - 1);
}

describe("blockCompressedCopyDim", () => {
    test("rounds a compressed extent up to whole 4x4 blocks", () => {
        for (const fmt of [D3DFMT_DXT1, D3DFMT_DXT2, D3DFMT_DXT3, D3DFMT_DXT4, D3DFMT_DXT5]) {
            expect(blockCompressedCopyDim(fmt, 1)).toBe(4);
            expect(blockCompressedCopyDim(fmt, 2)).toBe(4);
            expect(blockCompressedCopyDim(fmt, 4)).toBe(4);
            expect(blockCompressedCopyDim(fmt, 5)).toBe(8);
            expect(blockCompressedCopyDim(fmt, 256)).toBe(256);
        }
    });

    // The format argument is the whole point of the signature: rounding an UNCOMPRESSED copy up
    // to 4 is the same class of invalid copy in the other direction, so the helper has to be
    // unable to do it rather than merely documented not to.
    test("leaves an uncompressed extent alone", () => {
        expect(blockCompressedCopyDim(D3DFMT_A8R8G8B8, 2)).toBe(2);
        expect(blockCompressedCopyDim(D3DFMT_A8R8G8B8, 33)).toBe(33);
    });
});

describe("BC mip-chain upload emits block-legal copies", () => {
    const formats = [
        ["DXT1", D3DFMT_DXT1],
        ["DXT2", D3DFMT_DXT2],
        ["DXT3", D3DFMT_DXT3],
        ["DXT4", D3DFMT_DXT4],
        ["DXT5", D3DFMT_DXT5],
    ] as const;

    for (const [name, format] of formats) {
        // 256x256 exercises a full chain (the 2x2 and 1x1 tails at levels 7/8 are the failure
        // case); the non-square and NPOT sizes make width and height reach the tail at
        // different levels; 2x2 and 1x1 are textures that are ONLY a tail.
        for (const [w, h] of [[256, 256], [64, 16], [96, 24], [8, 8], [4, 4], [2, 2], [1, 1]]) {
            test(`${name} ${w}x${h} — every level down to the 1x1 tail`, () => {
                const chain = emitChain(format, w, h);
                expect(chain.length).toBe(mipLevelCountFor(w, h));
                for (const p of chain) {
                    const errs = webgpuCopyErrors(
                        p,
                        physical(mipExtent(w, p.level)),
                        physical(mipExtent(h, p.level)),
                        getD3DTextureLayout(format, 4, 4).blockBytes,
                    );
                    expect({ level: p.level, errs }).toEqual({ level: p.level, errs: [] });
                }
            });
        }
    }

    // Negative control: without the rounding the emitted copies really are rejected, so a green
    // suite above means the helper is doing the work rather than the model being permissive.
    test("the logical-extent computation is what WebGPU rejects (pre-fix behaviour)", () => {
        // A 256x256 DXT1 chain: levels 7 and 8 are 2x2 and 1x1 — sub-block tails.
        const errs = emitChainLogical(D3DFMT_DXT1, 256, 256).flatMap((p) =>
            webgpuCopyErrors(p, physical(mipExtent(256, p.level)), physical(mipExtent(256, p.level)), 8),
        );
        expect(errs).toContain(
            "copySize.width (2) is not a multiple of compressed texture format block width (4).",
        );
        expect(errs).toContain(
            "copySize.width (1) is not a multiple of compressed texture format block width (4).",
        );
    });

    test("an uncompressed chain still copies at its logical extent", () => {
        for (let level = 0; level < mipLevelCountFor(64, 64); level++) {
            const w = mipExtent(64, level);
            expect(blockCompressedCopyDim(D3DFMT_A8R8G8B8, w)).toBe(w);
        }
    });
});
