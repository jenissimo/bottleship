/**
 * The cube .dds face walk.
 *
 * D3DXCreateCubeTextureFromFileInMemoryEx was declared but unimplemented, so it answered a
 * failure HRESULT and RA3 substituted its own placeholder for every cube map. The load-bearing
 * arithmetic in the implementation is the STRIDE: the file stores six faces back to back, each
 * carrying its whole mip chain, so a caller that asked for fewer levels must still advance over
 * the ones it skips. Getting that wrong reads the next face from the middle of this one — which
 * decodes as plausible garbage, never as an error.
 */
import { describe, expect, test } from "bun:test";
import { ddsCubeFaceLayout } from "../../src/worker/modules/d3d9/d3dx-bridge";
import { readDdsInfo } from "../../src/worker/modules/d3dx9/image-decode";

const D3DFMT_DXT1 = 0x31545844;
const D3DFMT_A8R8G8B8 = 21;
const DDSCAPS2_CUBEMAP = 0x200;
const D3DRTYPE_CUBETEXTURE = 5;

/** A cube .dds header carrying six faces of `mips` DXT1 levels. */
function cubeDds(edge: number, mips: number): Uint8Array {
    let payload = 0;
    for (let level = 0; level < mips; level++) {
        const size = Math.max(1, edge >>> level);
        payload += Math.max(1, Math.ceil(size / 4)) * Math.max(1, Math.ceil(size / 4)) * 8;
    }
    const bytes = new Uint8Array(128 + payload * 6);
    const u32 = new DataView(bytes.buffer);
    u32.setUint32(0, 0x20534444, true);   // "DDS "
    u32.setUint32(4, 124, true);
    u32.setUint32(12, edge, true);
    u32.setUint32(16, edge, true);
    u32.setUint32(28, mips, true);
    u32.setUint32(76, 32, true);
    u32.setUint32(80, 0x4, true);         // DDPF_FOURCC
    u32.setUint32(84, D3DFMT_DXT1, true);
    u32.setUint32(112, DDSCAPS2_CUBEMAP, true);
    return bytes;
}

describe("cube .dds", () => {
    test("readDdsInfo reports a cube as a cube, so the loader table picks the cube branch", () => {
        const info = readDdsInfo(cubeDds(64, 7));
        expect(info).not.toBeNull();
        expect(info!.resourceType).toBe(D3DRTYPE_CUBETEXTURE);
        expect(info!.width).toBe(64);
        expect(info!.claimedMipLevels).toBe(7);
        expect(info!.dataOffset).toBe(128);
    });

    test("the walk visits six faces, each with the file's whole chain, in order", () => {
        const slices = ddsCubeFaceLayout(D3DFMT_DXT1, 8, 4, 128);
        expect(slices.length).toBe(24);
        expect(slices.map((s) => s.face)).toEqual([
            0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5,
        ]);
        expect(slices.slice(0, 4).map((s) => s.level)).toEqual([0, 1, 2, 3]);
    });

    test("offsets are contiguous — the stride covers every level, asked for or not", () => {
        const slices = ddsCubeFaceLayout(D3DFMT_DXT1, 16, 5, 128);
        let at = 128;
        for (const s of slices) {
            expect(s.offset).toBe(at);
            at += s.bytes;
        }
        // DXT1, edge 16 → 16,8,4,2,1: 4x4,2x2,1x1 blocks then two levels that still cost a
        // whole block each — the sub-block tail is exactly what an offset walk gets wrong.
        const perFace = (at - 128) / 6;
        expect(perFace).toBe(128 + 32 + 8 + 8 + 8);
    });

    test("face N starts exactly one full chain after face N-1", () => {
        const slices = ddsCubeFaceLayout(D3DFMT_DXT1, 32, 6, 128);
        const starts = slices.filter((s) => s.level === 0).map((s) => s.offset);
        const chain = starts[1]! - starts[0]!;
        for (let face = 1; face < 6; face++) {
            expect(starts[face]! - starts[face - 1]!).toBe(chain);
        }
    });

    test("an uncompressed cube reports a row pitch, not a block one", () => {
        const [first] = ddsCubeFaceLayout(D3DFMT_A8R8G8B8, 64, 1, 128);
        expect(first!.pitch).toBe(64 * 4);
        expect(first!.bytes).toBe(64 * 64 * 4);
    });
});
