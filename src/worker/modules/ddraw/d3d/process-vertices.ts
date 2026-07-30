/**
 * IDirect3DVertexBuffer(7)::ProcessVertices — the DX6/DX7 software T&L stage.
 *
 * Reads untransformed vertices out of a source vertex buffer, runs the fixed-function
 * transform (world × view × projection) plus the viewport mapping, and writes the result
 * into the DESTINATION buffer in that buffer's own FVF. A destination created with
 * D3DFVF_XYZRHW therefore ends up holding screen-space vertices that a later
 * DrawPrimitiveVB / DrawIndexedPrimitiveVB draws directly.
 *
 * Vertex ops (D3DVOP_*):
 *   TRANSFORM — mandatory; without it the call is DDERR_INVALIDPARAMS.
 *   LIGHT     — gated per the DX6/DX7 rules below; the per-vertex lighting math itself
 *               lives in the WebGPU FFP shader, not here (see the LIGHT note in-line).
 *   CLIP      — the destination keeps the full projective mapping, so clipping happens
 *               downstream: the renderer reconstructs clip space from (x,y,z,rhw)
 *               exactly and the GPU clips there. See the CLIP note in-line.
 *   EXTENTS   — needs the device clip-status extents, which we do not track.
 */

import { Logger, LogCategory } from "../../../core/logger";

// d3dtypes.h FVF bits, restated locally (same values as ../constants) so this stays a
// dependency-free pure-math module the conformance test can import on its own.
const D3DFVF_POSITION_MASK = 0x400e;
const D3DFVF_XYZ = 0x0002;
const D3DFVF_XYZRHW = 0x0004;
const D3DFVF_NORMAL = 0x0010;
const D3DFVF_PSIZE = 0x0020;
const D3DFVF_DIFFUSE = 0x0040;
const D3DFVF_SPECULAR = 0x0080;
const D3DFVF_TEXCOUNT_MASK = 0x0f00;
const D3DFVF_TEXCOUNT_SHIFT = 8;

/** D3DVOP_* (d3dtypes.h). */
export const D3DVOP_TRANSFORM = 1 << 0;
export const D3DVOP_CLIP = 1 << 2;
export const D3DVOP_EXTENTS = 1 << 3;
export const D3DVOP_LIGHT = 1 << 10;

/** Number of float components a given texture stage carries in an FVF. */
function texCoordComponents(fvf: number, stage: number): number {
    switch ((fvf >>> (16 + stage * 2)) & 0x3) {
        case 0: return 2; // TEXTUREFORMAT2
        case 1: return 3; // TEXTUREFORMAT3
        case 2: return 4; // TEXTUREFORMAT4
        default: return 1; // TEXTUREFORMAT1
    }
}

/** Byte offsets of every component of an FVF, so src and dst can be walked independently. */
interface FvfLayout {
    posType: number;
    posOffset: number;
    normalOffset: number;   // -1 when absent
    diffuseOffset: number;  // -1 when absent
    specularOffset: number; // -1 when absent
    texOffsets: number[];   // per stage; [] when none
    texComponents: number[];
    stride: number;
}

export function fvfLayout(fvf: number): FvfLayout | null {
    const posType = fvf & D3DFVF_POSITION_MASK;
    let posBytes: number;
    switch (posType) {
        case D3DFVF_XYZ: posBytes = 12; break;
        case D3DFVF_XYZRHW: posBytes = 16; break;
        case 0x4002: posBytes = 16; break; // XYZW
        case 0x4006: posBytes = 16; break; // XYZB1
        case 0x4008: posBytes = 20; break; // XYZB2
        case 0x400a: posBytes = 24; break; // XYZB3
        case 0x400c: posBytes = 28; break; // XYZB4
        case 0x400e: posBytes = 32; break; // XYZB5
        default: return null;
    }
    let off = posBytes;
    const normalOffset = (fvf & D3DFVF_NORMAL) ? ((off += 12) - 12) : -1;
    if (fvf & D3DFVF_PSIZE) off += 4;
    const diffuseOffset = (fvf & D3DFVF_DIFFUSE) ? ((off += 4) - 4) : -1;
    const specularOffset = (fvf & D3DFVF_SPECULAR) ? ((off += 4) - 4) : -1;
    const texCount = (fvf & D3DFVF_TEXCOUNT_MASK) >> D3DFVF_TEXCOUNT_SHIFT;
    const texOffsets: number[] = [];
    const texComponents: number[] = [];
    for (let s = 0; s < texCount; s++) {
        const n = texCoordComponents(fvf, s);
        texOffsets.push(off);
        texComponents.push(n);
        off += n * 4;
    }
    return { posType, posOffset: 0, normalOffset, diffuseOffset, specularOffset, texOffsets, texComponents, stride: off };
}

export interface ProcessVerticesRequest {
    vertexOp: number;
    destIndex: number;
    srcIndex: number;
    count: number;
    /** Destination buffer (this). */
    dstAddr: number;
    dstFvf: number;
    dstStride: number;
    dstNumVertices: number;
    /** Source buffer. */
    srcAddr: number;
    srcFvf: number;
    srcStride: number;
    srcNumVertices: number;
    /** world × view × projection, row-major, D3D row-vector convention (v' = v·M). */
    mvp: Float32Array;
    /** Pixel rectangle plus the RASTERIZER depth range, which is always within [0,1]. */
    viewport: { x: number; y: number; width: number; height: number; minZ: number; maxZ: number };
    /**
     * Post-projection clip-space remap (ddraw/viewport.c update_clip_space): a D3DVIEWPORT2's
     * clipping volume and dvMinZ/dvMaxZ do NOT widen the rasterizer's depth range — they
     * scale/bias clip space ahead of it. Identity for the default volume (-1,1,2,2) and
     * z range 0..1, so it costs nothing for a well-behaved app; a GL-style wrapper asking
     * for z -1..1 gets the 0.5z+0.5w remap that makes it land in [0,1].
     */
    clipSpace: { sx: number; sy: number; sz: number; ox: number; oy: number; oz: number };
    /** D3DRENDERSTATE_LIGHTING at the time of the call. */
    lightingRenderState: boolean;
    /** True for a v3 (DX6) destination buffer — LIGHT is gated differently there. */
    legacyV3: boolean;
    /** Device material has been set at least once (the DX6 LIGHT gate). */
    hasMaterial: boolean;
    /** Material diffuse, used for the unlit destination-colour path. */
    materialDiffuseArgb: number;
    /** Material specular, used for the unlit destination-colour path. */
    materialSpecularArgb: number;
}

const DDERR_INVALIDPARAMS = 0x80070057; // E_INVALIDARG — ddraw.h aliases it onto the COM code.
const D3D_OK = 0;

let warnedLight = false;
let warnedExtents = false;

/**
 * Runs the pipeline. `mem` is the guest address space; every buffer address is a guest VA.
 * Returns an HRESULT.
 */
export function processVertices(mem: Uint8Array, req: ProcessVerticesRequest): number {
    // D3DVOP_TRANSFORM is not optional: without it there is nothing to write and real
    // ddraw fails the call outright.
    if (!(req.vertexOp & D3DVOP_TRANSFORM)) return DDERR_INVALIDPARAMS;
    if (req.count === 0) return D3D_OK;

    if (req.destIndex + req.count > req.dstNumVertices) return DDERR_INVALIDPARAMS;
    if (req.srcIndex + req.count > req.srcNumVertices) return DDERR_INVALIDPARAMS;

    const src = fvfLayout(req.srcFvf);
    const dst = fvfLayout(req.dstFvf);
    if (!src || !dst) return DDERR_INVALIDPARAMS;

    // LIGHT gate (ddraw/vertexbuffer.c): a DX6 buffer lights when a material is set and the
    // SOURCE carries normals; a DX7 buffer lights when D3DRENDERSTATE_LIGHTING is already on.
    // Either way the destination must have somewhere to put the result.
    const lightRequested = !!(req.vertexOp & D3DVOP_LIGHT);
    const dstHasColour = (req.dstFvf & (D3DFVF_DIFFUSE | D3DFVF_SPECULAR)) !== 0;
    const lighting = lightRequested && dstHasColour &&
        (req.legacyV3 ? (req.hasMaterial && (req.srcFvf & D3DFVF_NORMAL) !== 0) : req.lightingRenderState);
    if (lighting && !warnedLight) {
        warnedLight = true;
        // Per-vertex FFP lighting is implemented in the WebGPU FFP shader, which only sees
        // the post-T&L stream. Baking it here would be a second, divergent implementation,
        // so the destination colours fall through to the unlit path below.
        Logger.warn(LogCategory.DDRAW,
            "ProcessVertices: D3DVOP_LIGHT requested — per-vertex lighting is not computed here; " +
            "destination colours use the unlit (material/source-colour) path.");
    }
    if ((req.vertexOp & D3DVOP_EXTENTS) && !warnedExtents) {
        warnedExtents = true;
        Logger.warn(LogCategory.DDRAW, "ProcessVertices: D3DVOP_EXTENTS requested — screen extents are not tracked.");
    }

    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    const m = req.mvp;
    const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
    const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
    const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
    const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];

    const cs = req.clipSpace;
    const vp = req.viewport;
    const halfW = vp.width / 2;
    const halfH = vp.height / 2;
    const minZ = vp.minZ;
    // wined3d_viewport_get_z_range: a degenerate range is widened rather than dividing by zero.
    const maxZ = Math.max(vp.maxZ, minZ + 0.001);
    const zRange = maxZ - minZ;

    const dstIsRhw = (dst.posType & D3DFVF_POSITION_MASK) === D3DFVF_XYZRHW;
    const dstWritesPos = dstIsRhw || (dst.posType & D3DFVF_POSITION_MASK) === D3DFVF_XYZ;
    const texPairs = Math.min(dst.texOffsets.length, src.texOffsets.length);

    let srcBase = req.srcAddr + req.srcIndex * req.srcStride;
    let dstBase = req.dstAddr + req.destIndex * req.dstStride;

    for (let i = 0; i < req.count; i++, srcBase += req.srcStride, dstBase += req.dstStride) {
        const px = view.getFloat32(srcBase, true);
        const py = view.getFloat32(srcBase + 4, true);
        const pz = view.getFloat32(srcBase + 8, true);

        if (dstWritesPos) {
            const xc = px * m0 + py * m4 + pz * m8 + m12;
            const yc = px * m1 + py * m5 + pz * m9 + m13;
            const zc = px * m2 + py * m6 + pz * m10 + m14;
            const w = px * m3 + py * m7 + pz * m11 + m15;
            const x = xc * cs.sx + w * cs.ox;
            const y = yc * cs.sy + w * cs.oy;
            const z = zc * cs.sz + w * cs.oz;

            // D3DVOP_CLIP: the mapping below is projective and invertible, so a vertex outside
            // the frustum still carries its exact clip-space position in (x,y,z,rhw) and the
            // renderer's XYZRHW path reconstructs it (clip = ndc · w, w = 1/rhw) before the GPU
            // clips. Emitting the alternate "clipped vertex" encoding instead would destroy that
            // information — Wine ships the same unconditional mapping for exactly this reason.
            const invW = w !== 0 ? 1 / w : 0;
            view.setFloat32(dstBase, (x * invW) * halfW + halfW + vp.x, true);
            view.setFloat32(dstBase + 4, (-y * invW) * halfH + halfH + vp.y, true);
            view.setFloat32(dstBase + 8, (z * invW) * zRange + minZ, true);
            if (dstIsRhw) view.setFloat32(dstBase + 12, invW, true);
        }

        if (dst.normalOffset >= 0) {
            if (src.normalOffset >= 0) {
                view.setFloat32(dstBase + dst.normalOffset, view.getFloat32(srcBase + src.normalOffset, true), true);
                view.setFloat32(dstBase + dst.normalOffset + 4, view.getFloat32(srcBase + src.normalOffset + 4, true), true);
                view.setFloat32(dstBase + dst.normalOffset + 8, view.getFloat32(srcBase + src.normalOffset + 8, true), true);
            } else {
                view.setFloat32(dstBase + dst.normalOffset, 0, true);
                view.setFloat32(dstBase + dst.normalOffset + 4, 0, true);
                view.setFloat32(dstBase + dst.normalOffset + 8, 1, true);
            }
        }

        // Unlit colours come from the source vertex when it has them (D3DMCS_COLOR1/2, the
        // default material colour source for a lit FVF), else from the material.
        if (dst.diffuseOffset >= 0) {
            view.setUint32(dstBase + dst.diffuseOffset,
                src.diffuseOffset >= 0 ? view.getUint32(srcBase + src.diffuseOffset, true) : req.materialDiffuseArgb, true);
        }
        if (dst.specularOffset >= 0) {
            view.setUint32(dstBase + dst.specularOffset,
                src.specularOffset >= 0 ? view.getUint32(srcBase + src.specularOffset, true) : req.materialSpecularArgb, true);
        }

        for (let s = 0; s < texPairs; s++) {
            const n = Math.min(dst.texComponents[s], src.texComponents[s]);
            const so = srcBase + src.texOffsets[s];
            const doff = dstBase + dst.texOffsets[s];
            for (let c = 0; c < n; c++) view.setFloat32(doff + c * 4, view.getFloat32(so + c * 4, true), true);
            for (let c = n; c < dst.texComponents[s]; c++) view.setFloat32(doff + c * 4, 0, true);
        }
        // A destination stage with no source stage keeps whatever it held; real ddraw logs the
        // same mismatch and leaves the bytes alone.
    }

    return D3D_OK;
}
